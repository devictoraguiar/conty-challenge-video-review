import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase, transaction } from '../src/database.js';

describe('transaction integrity', () => {
  it('rolls back a version insert if reopening the approved delivery fails', async () => {
    const db = createDatabase();
    const app = createApp({ db });
    const post = (path: string, input?: unknown) => app.request(path, {
      method: 'POST', ...(input === undefined ? {} : {
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
      }),
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const campaign = await (await post('/campaigns', { title: 'Launch', requiredPieces: ['video'] })).json();
      const delivery = await (await post('/deliveries', { campaignId: campaign.id, creatorId: 'creator' })).json();
      const uploaded = await (await post(`/deliveries/${delivery.id}/pieces/video/versions`, { content: 'v1.mp4' })).json();
      const versionId = uploaded.pieces[0].currentVersionId;
      expect((await post(`/deliveries/${delivery.id}/pieces/video/versions/${versionId}/approval`)).status).toBe(200);
      const approved = await (await post(`/deliveries/${delivery.id}/approval`)).json();
      expect(approved.status).toBe('approved');
      db.exec(`CREATE TRIGGER fail_reopen BEFORE UPDATE ON deliveries
        BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`);
      expect((await post(`/deliveries/${delivery.id}/pieces/video/versions`, { content: 'v2.mp4' })).status).toBe(500);
      expect(await (await app.request(`/deliveries/${delivery.id}`)).json()).toEqual(approved);
      db.exec('DROP TRIGGER fail_reopen');
      const recovered = await (await post(`/deliveries/${delivery.id}/pieces/video/versions`, { content: 'v2.mp4' })).json();
      expect(recovered.status).toBe('in_production');
      expect(recovered.approvedAt).toBeNull();
      expect(recovered.pendingPieces).toEqual(['video']);
      expect(recovered.pieces[0].versions.map((v: { number: number }) => v.number)).toEqual([1, 2]);
    } finally {
      errors.mockRestore();
      db.close();
    }
  });

  it('allows committed read snapshots while another connection holds the writer lock', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'conty-reader-'));
    const path = join(directory, 'review.sqlite');
    const writer = createDatabase(path);
    const reader = createDatabase(path);
    try {
      const app = createApp({ db: writer });
      const parent = await (await app.request('/campaigns', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Committed', requiredPieces: ['video'] }),
      })).json();
      reader.exec('PRAGMA busy_timeout = 0');
      writer.exec('BEGIN IMMEDIATE');
      writer.prepare('UPDATE campaigns SET title = ? WHERE id = ?').run('Uncommitted', parent.id);
      const response = await createApp({ db: reader }).request(`/campaigns/${parent.id}`);
      expect(response.status).toBe(200);
      expect((await response.json()).title).toBe('Committed');
      writer.exec('ROLLBACK');
    } finally {
      reader.close();
      writer.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves the original failure when the transaction has already rolled back', () => {
    const db = createDatabase();
    const original = new Error('original failure');
    try {
      expect(() => transaction(db, () => {
        db.exec('ROLLBACK');
        throw original;
      })).toThrow(original);
      expect(() => transaction(db, () => db.prepare('SELECT 1').get())).not.toThrow();
    } finally {
      db.close();
    }
  });
});
