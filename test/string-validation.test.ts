import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/database.js';

let db: ReturnType<typeof createDatabase>;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  db = createDatabase();
  app = createApp({ db, now: () => new Date('2026-10-10T00:00:00Z') });
});
afterEach(() => db.close());

const post = (path: string, input?: unknown) => app.request(path, {
  method: 'POST', ...(input === undefined ? {} : {
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  }),
});
async function createApproved() {
  const campaign = await (await post('/campaigns', { title: 'Launch', requiredPieces: ['video'] })).json();
  const delivery = await (await post('/deliveries', { campaignId: campaign.id, creatorId: 'creator' })).json();
  const uploaded = await (await post(`/deliveries/${delivery.id}/pieces/video/versions`, { content: 'v1.mp4' })).json();
  const versionId = uploaded.pieces[0].currentVersionId as string;
  expect((await post(`/deliveries/${delivery.id}/pieces/video/versions/${versionId}/approval`)).status).toBe(200);
  const approved = await (await post(`/deliveries/${delivery.id}/approval`)).json();
  expect(approved.status).toBe('approved');
  return { campaign, approved, versionId };
}

const fields = ['title', 'creatorId', 'content', 'text'] as const;
const cases = fields.flatMap((field) => ['\u0000after', 'before\u0000after', 'before\u0000']
  .map((value) => ({ field, value })));

describe('text fidelity at the SQLite boundary', () => {
  it.each(cases)('rejects NUL in $field ($value) before any write', async ({ field, value }) => {
    const { campaign, approved, versionId } = await createApproved();
    const base = `/deliveries/${approved.id}`;
    const requests = {
      title: { path: '/campaigns', input: { title: value, requiredPieces: ['video'] } },
      creatorId: { path: '/deliveries', input: { campaignId: campaign.id, creatorId: value } },
      content: { path: `${base}/pieces/video/versions`, input: { content: value } },
      text: { path: `${base}/pieces/video/versions/${versionId}/comments`, input: { second: 12.5, text: value } },
    };
    const request = requests[field];
    const rejected = await post(request.path, request.input);
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error).toContain('U+0000');
    expect(await (await app.request(base)).json()).toEqual(approved);
    expect(await (await app.request(`/campaigns/${campaign.id}`)).json()).toEqual(campaign);
    for (const [table, count] of [['campaigns', 1], ['deliveries', 1], ['piece_versions', 1], ['video_comments', 0]] as const) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count });
    }
    const next = await (await post(`${base}/pieces/video/versions`, { content: 'v2.mp4' })).json();
    expect(next.pieces[0].versions.map((version: { number: number }) => version.number)).toEqual([1, 2]);
    expect(next.status).toBe('in_production');
  });

  it('preserves valid Unicode and whitespace instead of sanitizing text', async () => {
    const text = '  Ação 🎬 — 日本語\nRevisão\tfinal  ';
    const campaign = await (await post('/campaigns', { title: text, requiredPieces: ['video'] })).json();
    expect(campaign.title).toBe(text);
    const created = await (await post('/deliveries', { campaignId: campaign.id, creatorId: text })).json();
    const uploaded = await (await post(`/deliveries/${created.id}/pieces/video/versions`, { content: text })).json();
    const versionId = uploaded.pieces[0].currentVersionId;
    const comment = await (await post(`/deliveries/${created.id}/pieces/video/versions/${versionId}/comments`, { second: 0, text })).json();
    expect(comment.text).toBe(text);
    const fetched = await (await app.request(`/deliveries/${created.id}`)).json();
    expect(fetched.creatorId).toBe(text);
    expect(fetched.pieces[0].versions[0].content).toBe(text);
    expect(fetched.pieces[0].versions[0].comments).toEqual([comment]);
    expect((await (await app.request(`/campaigns/${campaign.id}`)).json()).title).toBe(text);
  });
});
