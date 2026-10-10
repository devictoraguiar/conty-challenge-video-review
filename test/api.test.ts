import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase } from '../src/database.js';
import { createApp } from '../src/app.js';

type Kind = 'script' | 'video' | 'cover' | 'caption';
interface Comment {
  id: string;
  versionId: string;
  second: number;
  text: string;
  createdAt: string;
}
interface Version {
  id: string;
  number: number;
  content: string;
  status: 'in_review' | 'approved';
  approvedAt: string | null;
  createdAt: string;
  isCurrent: boolean;
  comments: Comment[];
}
interface Delivery {
  id: string;
  campaignId: string;
  creatorId: string;
  status: 'in_production' | 'approved';
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  requiredPieces: Kind[];
  pendingPieces: Kind[];
  pieces: { kind: Kind; currentVersionId: string; versions: Version[] }[];
}
interface Campaign {
  id: string;
  title: string;
  requiredPieces: Kind[];
  createdAt: string;
}

const kinds: Kind[] = ['script', 'video', 'cover', 'caption'];
let db: ReturnType<typeof createDatabase>;
let app: ReturnType<typeof createApp>;
let time: Date;
const temporaryDirectories: string[] = [];

beforeEach(() => {
  time = new Date('2026-01-02T03:04:05.000Z');
  db = createDatabase();
  app = createApp({ db, now: () => new Date(time) });
});
afterEach(() => {
  db.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tick() {
  time = new Date(time.getTime() + 1000);
}
async function request(path: string, body?: unknown, method = 'POST') {
  return app.request(path, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
}
async function result<T>(response: Response, status: number): Promise<T> {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/json');
  return await response.json() as T;
}
async function campaign(requiredPieces: Kind[] = ['video'], title = 'Campaign') {
  return result<Campaign>(await request('/campaigns', { title, requiredPieces }), 201);
}
async function delivery(requiredPieces: Kind[] = ['video'], creatorId = 'creator-a') {
  const parent = await campaign(requiredPieces);
  return result<Delivery>(await request('/deliveries', { campaignId: parent.id, creatorId }), 201);
}
async function getDelivery(id: string) {
  return result<Delivery>(await request(`/deliveries/${id}`, undefined, 'GET'), 200);
}
async function upload(id: string, kind: Kind, content = `${kind} content`) {
  return result<Delivery>(await request(`/deliveries/${id}/pieces/${kind}/versions`, { content }), 201);
}
function current(view: Delivery, kind: Kind): Version {
  const piece = view.pieces.find((candidate) => candidate.kind === kind);
  expect(piece).toBeDefined();
  const version = piece!.versions.find((candidate) => candidate.id === piece!.currentVersionId);
  expect(version).toBeDefined();
  expect(version!.isCurrent).toBe(true);
  return version!;
}
async function approveVersion(id: string, kind: Kind, versionId: string) {
  return result<Delivery>(await request(`/deliveries/${id}/pieces/${kind}/versions/${versionId}/approval`), 200);
}
async function approveDelivery(id: string) {
  return result<Delivery>(await request(`/deliveries/${id}/approval`), 200);
}
async function ready(requiredPieces: Kind[] = ['video']) {
  let view = await delivery(requiredPieces);
  for (const kind of requiredPieces) {
    view = await upload(view.id, kind);
    view = await approveVersion(view.id, kind, current(view, kind).id);
  }
  return view;
}
async function conflict(id: string, pendingPieces: Kind[], body?: unknown) {
  const error = await result<{ error: string; code: string; pendingPieces: Kind[] }>(
    await request(`/deliveries/${id}/approval`, body), 409,
  );
  expect(error.code).toBe('REQUIRED_PIECES_PENDING');
  expect(error.pendingPieces).toHaveLength(pendingPieces.length);
  expect(error.pendingPieces).toEqual(expect.arrayContaining(pendingPieces));
  expect(error.error).toMatch(/obrigat|pendente|aprovad|aprova/i);
  expect(error.error.trim().length).toBeGreaterThan(10);
}
async function getVersion(id: string, kind: Kind, versionId: string) {
  return result<Version>(await request(`/deliveries/${id}/pieces/${kind}/versions/${versionId}`, undefined, 'GET'), 200);
}
async function comment(id: string, versionId: string, second: number, text: string) {
  return result<Comment>(await request(`/deliveries/${id}/pieces/video/versions/${versionId}/comments`, { second, text }), 201);
}

describe('campaigns and delivery approval', () => {
  it('stores campaign-defined requirements and starts with every missing piece pending', async () => {
    const parent = await campaign(kinds, 'Launch');
    expect(parent).toEqual({
      id: expect.any(String), title: 'Launch', requiredPieces: kinds,
      createdAt: time.toISOString(),
    });
    expect(parent.id.length).toBeGreaterThan(0);
    expect(await result<Campaign>(await request(`/campaigns/${parent.id}`, undefined, 'GET'), 200)).toEqual(parent);
    const view = await result<Delivery>(await request('/deliveries', { campaignId: parent.id, creatorId: 'creator-z' }), 201);
    expect(view).toEqual({
      id: expect.any(String), campaignId: parent.id, creatorId: 'creator-z',
      status: 'in_production', approvedAt: null,
      createdAt: time.toISOString(), updatedAt: time.toISOString(),
      requiredPieces: kinds, pendingPieces: kinds, pieces: [],
    });
    await conflict(view.id, kinds);
    expect(await getDelivery(view.id)).toEqual(view);
  });

  it.each(kinds)('requires the current %s even when all other required pieces are approved', async (missing) => {
    let view = await delivery(kinds);
    for (const kind of kinds.filter((kind) => kind !== missing)) {
      view = await upload(view.id, kind);
      view = await approveVersion(view.id, kind, current(view, kind).id);
    }
    expect(view.pendingPieces).toEqual([missing]);
    await conflict(view.id, [missing]);
    view = await upload(view.id, missing);
    expect(current(view, missing).status).toBe('in_review');
    expect(view.pendingPieces).toEqual([missing]);
    await conflict(view.id, [missing]);
    const beforeFailure = await getDelivery(view.id);
    await conflict(view.id, [missing], { status: 'approved', pendingPieces: [], requiredPieces: [] });
    expect(await getDelivery(view.id)).toEqual(beforeFailure);
    view = await approveVersion(view.id, missing, current(view, missing).id);
    expect(view.pendingPieces).toEqual([]);
    expect(view.status).toBe('in_production');
    expect(view.approvedAt).toBeNull();
    tick();
    view = await approveDelivery(view.id);
    expect(view.status).toBe('approved');
    expect(view.approvedAt).toBe(time.toISOString());
  });

  it('approves a video-only campaign without inventing a script requirement', async () => {
    const view = await ready();
    expect(view.requiredPieces).toEqual(['video']);
    expect(view.pieces.map((piece) => piece.kind)).toEqual(['video']);
    expect((await approveDelivery(view.id)).status).toBe('approved');
  });

  it('optional, unapproved pieces do not block approval', async () => {
    let view = await ready(['video']);
    for (const kind of ['script', 'cover', 'caption'] as Kind[]) {
      view = await upload(view.id, kind);
      expect(current(view, kind).status).toBe('in_review');
      expect(view.pendingPieces).toEqual([]);
    }
    expect((await approveDelivery(view.id)).status).toBe('approved');
  });

  it('approval endpoints are idempotent and preserve original approval timestamps', async () => {
    let view = await ready();
    const version = current(view, 'video');
    tick();
    const repeated = await approveVersion(view.id, 'video', version.id);
    expect(current(repeated, 'video')).toEqual(version);
    expect(repeated.status).toBe('in_production');
    view = await approveDelivery(view.id);
    tick();
    expect(await approveDelivery(view.id)).toEqual(view);
    expect(await approveVersion(view.id, 'video', version.id)).toEqual(view);
  });
});

describe('version replacement and retained history', () => {
  it.each(kinds)('a new required %s version reopens approved delivery until both approvals happen', async (kind) => {
    let view = await ready([kind]);
    const original = current(view, kind);
    expect(original.approvedAt).toBe(time.toISOString());
    view = await approveDelivery(view.id);
    const deliveryCreatedAt = view.createdAt;
    tick();
    view = await upload(view.id, kind, 'replacement');
    expect(view.status).toBe('in_production');
    expect(view.approvedAt).toBeNull();
    expect(view.pendingPieces).toEqual([kind]);
    expect(view.createdAt).toBe(deliveryCreatedAt);
    expect(view.updatedAt).toBe(time.toISOString());
    const replacement = current(view, kind);
    expect(replacement).toEqual({
      id: expect.any(String), number: 2, content: 'replacement', status: 'in_review',
      approvedAt: null, createdAt: time.toISOString(), isCurrent: true, comments: [],
    });
    expect(replacement.id).not.toBe(original.id);
    expect(view.pieces[0].versions).toEqual([{ ...original, isCurrent: false }, replacement]);
    await conflict(view.id, [kind]);
    const before = await getDelivery(view.id);
    expect((await request(`/deliveries/${view.id}/pieces/${kind}/versions/${original.id}/approval`)).status).toBe(409);
    expect(await getDelivery(view.id)).toEqual(before);
    view = await approveVersion(view.id, kind, replacement.id);
    expect(view.status).toBe('in_production');
    expect(view.approvedAt).toBeNull();
    expect(view.pendingPieces).toEqual([]);
    tick();
    view = await approveDelivery(view.id);
    expect(view.status).toBe('approved');
    expect(view.approvedAt).toBe(time.toISOString());
    expect(await getVersion(view.id, kind, original.id)).toEqual({ ...original, isCurrent: false });
  });

  it.each(kinds)('new optional %s reopens delivery, but requires only explicit delivery reapproval', async (optional) => {
    const required = kinds.find((kind) => kind !== optional)!;
    let view = await ready([required]);
    view = await upload(view.id, optional, 'optional first');
    view = await approveDelivery(view.id);
    tick();
    view = await upload(view.id, optional, 'optional second');
    expect(view.status).toBe('in_production');
    expect(view.approvedAt).toBeNull();
    expect(view.pendingPieces).toEqual([]);
    expect(current(view, optional).status).toBe('in_review');
    view = await approveDelivery(view.id);
    expect(view.status).toBe('approved');
    expect(current(view, optional).status).toBe('in_review');
  });

  it.each(kinds)('the first optional %s upload also reopens an approved delivery', async (optional) => {
    const required = kinds.find((kind) => kind !== optional)!;
    let view = await ready([required]);
    view = await approveDelivery(view.id);
    tick();
    view = await upload(view.id, optional, 'first optional upload');
    expect(view.status).toBe('in_production');
    expect(view.approvedAt).toBeNull();
    expect(view.pendingPieces).toEqual([]);
    expect(current(view, optional).number).toBe(1);
    expect(current(view, optional).status).toBe('in_review');
    expect((await approveDelivery(view.id)).status).toBe('approved');
  });

  it('numbers versions independently per piece and returns stable, ascending history', async () => {
    let view = await delivery(kinds);
    for (const kind of [...kinds].reverse()) {
      view = await upload(view.id, kind, `${kind} one`);
      expect(current(view, kind).number).toBe(1);
    }
    view = await upload(view.id, 'video', 'video two');
    view = await upload(view.id, 'video', 'video three');
    view = await upload(view.id, 'script', 'script two');
    expect(view.pieces.find((piece) => piece.kind === 'video')!.versions.map((version) => version.number)).toEqual([1, 2, 3]);
    expect(current(view, 'script').number).toBe(2);
    expect(current(view, 'cover').number).toBe(1);
    expect(current(view, 'caption').number).toBe(1);
    for (const piece of view.pieces) {
      expect(piece.versions.filter((version) => version.isCurrent)).toHaveLength(1);
      expect(piece.versions.at(-1)!.id).toBe(piece.currentVersionId);
    }
    expect(await getDelivery(view.id)).toEqual(view);
    expect(await getDelivery(view.id)).toEqual(view);
  });

  it.each(['https://example.invalid/video.mp4', 'fake-upload://cover.png', 'Caption text'])('accepts opaque content %s without fetching media', async (content) => {
    const view = await delivery();
    const uploaded = await upload(view.id, 'video', content);
    expect(current(uploaded, 'video').content).toBe(content);
  });
});

describe('video comments and resource scope', () => {
  it('anchors zero and fractional seconds to an exact version; never migrates comments', async () => {
    let view = await ready();
    const first = current(view, 'video');
    view = await approveDelivery(view.id);
    const approvedDelivery = view;
    const zero = await comment(view.id, first.id, 0, 'Opening frame');
    const fractional = await comment(view.id, first.id, 1.25, 'Cut here');
    expect(zero).toEqual({ id: expect.any(String), versionId: first.id, second: 0, text: 'Opening frame', createdAt: time.toISOString() });
    expect(fractional.second).toBe(1.25);
    expect(fractional.versionId).toBe(first.id);
    expect(fractional.id).not.toBe(zero.id);
    const withComments = await getDelivery(view.id);
    expect(withComments.status).toBe('approved');
    expect(withComments.approvedAt).toBe(approvedDelivery.approvedAt);
    expect(current(withComments, 'video').comments).toEqual([zero, fractional]);
    tick();
    view = await upload(view.id, 'video', 'new cut');
    const second = current(view, 'video');
    expect(second.comments).toEqual([]);
    const oldComment = await comment(view.id, first.id, 99999.5, 'Historical feedback without duration metadata');
    const newComment = await comment(view.id, second.id, 3.5, 'New cut feedback');
    expect((await getVersion(view.id, 'video', first.id)).comments).toEqual([zero, fractional, oldComment]);
    expect((await getVersion(view.id, 'video', second.id)).comments).toEqual([newComment]);
    const final = await getDelivery(view.id);
    expect(final.pieces[0].versions[0].comments).toEqual([zero, fractional, oldComment]);
    expect(current(final, 'video').comments).toEqual([newComment]);
  });

  it('cannot read, approve, or comment on a version under another delivery or kind', async () => {
    const parent = await campaign(['video']);
    let a = await result<Delivery>(await request('/deliveries', { campaignId: parent.id, creatorId: 'alice' }), 201);
    let b = await result<Delivery>(await request('/deliveries', { campaignId: parent.id, creatorId: 'bob' }), 201);
    a = await upload(a.id, 'video', 'alice video');
    a = await upload(a.id, 'script', 'alice script');
    b = await upload(b.id, 'video', 'bob video');
    const videoA = current(a, 'video');
    const scriptA = current(a, 'script');
    const videoB = current(b, 'video');
    for (const [id, kind, versionId] of [
      [b.id, 'video', videoA.id], [a.id, 'script', videoA.id],
      [a.id, 'video', scriptA.id], [a.id, 'video', videoB.id],
      [a.id, 'video', 'missing-version'],
    ]) {
      expect((await request(`/deliveries/${id}/pieces/${kind}/versions/${versionId}`, undefined, 'GET')).status).toBe(404);
      expect((await request(`/deliveries/${id}/pieces/${kind}/versions/${versionId}/approval`)).status).toBe(404);
    }
    for (const [id, versionId] of [[b.id, videoA.id], [a.id, scriptA.id], [a.id, 'missing-version']]) {
      expect((await request(`/deliveries/${id}/pieces/video/versions/${versionId}/comments`, { second: 0, text: 'wrong scope' })).status).toBe(404);
    }
    expect((await request(`/deliveries/${a.id}/pieces/script/versions/${scriptA.id}/comments`, { second: 0, text: 'not video' })).status).toBe(404);
    expect(await getDelivery(a.id)).toEqual(a);
    expect(await getDelivery(b.id)).toEqual(b);
    a = await approveVersion(a.id, 'video', videoA.id);
    expect(a.pendingPieces).toEqual([]);
    await conflict(b.id, ['video']);
    expect(current(await getDelivery(b.id), 'video').status).toBe('in_review');
  });

  it('keeps requirements isolated across campaigns and creators', async () => {
    const videoOnly = await ready(['video']);
    let all = await delivery(kinds, 'creator-other');
    all = await upload(all.id, 'video');
    all = await approveVersion(all.id, 'video', current(all, 'video').id);
    expect((await approveDelivery(videoOnly.id)).status).toBe('approved');
    await conflict(all.id, ['script', 'cover', 'caption']);
    expect((await getDelivery(all.id)).requiredPieces).toEqual(kinds);
  });
});

describe('validation and missing resources', () => {
  it.each([
    {}, { title: '', requiredPieces: ['video'] }, { title: '   ', requiredPieces: ['video'] },
    { title: 1, requiredPieces: ['video'] }, { title: 'Title', requiredPieces: [] },
    { title: 'Title', requiredPieces: ['video', 'video'] },
    { title: 'Title', requiredPieces: ['audio'] }, { title: 'Title', requiredPieces: 'video' },
    { title: 'Title', requiredPieces: [null] }, { title: 'Title', requiredPieces: [1] },
  ])('rejects invalid campaign input %#', async (body) => {
    expect((await request('/campaigns', body)).status).toBe(400);
  });

  it('rejects invalid delivery input and unknown campaign without creating a valid delivery', async () => {
    const parent = await campaign();
    for (const body of [{}, { campaignId: parent.id }, { campaignId: parent.id, creatorId: '' },
      { campaignId: parent.id, creatorId: '  ' }, { campaignId: parent.id, creatorId: 3 },
      { campaignId: 3, creatorId: 'creator' }, { campaignId: '', creatorId: 'creator' }]) {
      expect((await request('/deliveries', body)).status).toBe(400);
    }
    expect((await request('/deliveries', { campaignId: 'missing-campaign', creatorId: 'creator' })).status).toBe(404);
  });

  it('returns 404 for missing resources and 400 for an unknown piece kind', async () => {
    expect((await request('/campaigns/missing', undefined, 'GET')).status).toBe(404);
    expect((await request('/deliveries/missing', undefined, 'GET')).status).toBe(404);
    expect((await request('/deliveries/missing/approval')).status).toBe(404);
    expect((await request('/deliveries/missing/pieces/video/versions', { content: 'video' })).status).toBe(404);
    const view = await delivery();
    expect((await request(`/deliveries/${view.id}/pieces/audio/versions`, { content: 'audio' })).status).toBe(400);
    expect((await request(`/deliveries/${view.id}/pieces/video/versions/missing`, undefined, 'GET')).status).toBe(404);
    expect((await request('/deliveries/missing/pieces/video/versions/missing/approval')).status).toBe(404);
    expect((await request('/deliveries/missing/pieces/video/versions/missing/comments', { second: 0, text: 'x' })).status).toBe(404);
    expect(await getDelivery(view.id)).toEqual(view);
  });

  it('invalid uploads do not reopen an approved delivery or consume a version number', async () => {
    let view = await ready();
    view = await approveDelivery(view.id);
    tick();
    for (const body of [{}, { content: '' }, { content: ' \n\t ' }, { content: null },
      { content: 12 }, { content: [] }, { content: {} }]) {
      expect((await request(`/deliveries/${view.id}/pieces/video/versions`, body)).status).toBe(400);
      expect(await getDelivery(view.id)).toEqual(view);
    }
    const next = await upload(view.id, 'video');
    expect(current(next, 'video').number).toBe(2);
  });

  it('validates comment numbers without coercion and nonblank text without altering history', async () => {
    const view = await ready();
    const version = current(view, 'video');
    const path = `/deliveries/${view.id}/pieces/video/versions/${version.id}/comments`;
    for (const body of [
      {}, { second: -1, text: 'x' }, { second: '-1', text: 'x' },
      { second: '0', text: 'x' }, { second: null, text: 'x' },
      { second: true, text: 'x' }, { second: [], text: 'x' },
      { second: 0 }, { second: 0, text: '' }, { second: 0, text: ' \t\n ' },
      { second: 0, text: 3 }, { second: 0, text: null },
    ]) {
      expect((await request(path, body)).status).toBe(400);
    }
    // 1e309 is legal JSON syntax but parses as Infinity in JavaScript.
    expect((await app.request(path, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: '{"second":1e309,"text":"nonfinite"}',
    })).status).toBe(400);
    expect(await getDelivery(view.id)).toEqual(view);
  });

  it('rejects malformed JSON and nonobject JSON cleanly on body-taking endpoints', async () => {
    const view = await ready();
    const version = current(view, 'video');
    const paths = ['/campaigns', '/deliveries',
      `/deliveries/${view.id}/pieces/video/versions`,
      `/deliveries/${view.id}/pieces/video/versions/${version.id}/comments`];
    for (const path of paths) {
      for (const body of ['{', '', 'null', '[]', '"text"', '42', 'true']) {
        const response = await app.request(path, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body,
        });
        const error = await result<{ error: string }>(response, 400);
        expect(error.error).toEqual(expect.any(String));
        expect(error.error.trim().length).toBeGreaterThan(0);
      }
    }
    expect(await getDelivery(view.id)).toEqual(view);
  });
});

describe('persistence and request-body races', () => {
  it('retains reopened delivery, current readiness, approval history and version-specific comments after database reopen', async () => {
    db.close();
    const directory = mkdtempSync(join(tmpdir(), 'conty-review-test-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'review.sqlite');
    db = createDatabase(file);
    app = createApp({ db, now: () => new Date(time) });
    let view = await ready(kinds);
    const firstVideo = current(view, 'video');
    const firstComment = await comment(view.id, firstVideo.id, 0.75, 'Keep this history');
    view = await approveDelivery(view.id);
    tick();
    view = await upload(view.id, 'video', 'persisted replacement');
    const secondVideo = current(view, 'video');
    const secondComment = await comment(view.id, secondVideo.id, 0, 'New version only');
    const snapshot = await getDelivery(view.id);
    const parent = await result<Campaign>(await request(`/campaigns/${view.campaignId}`, undefined, 'GET'), 200);
    db.close();
    db = createDatabase(file);
    app = createApp({ db, now: () => new Date(time) });
    expect(await getDelivery(view.id)).toEqual(snapshot);
    expect(await result<Campaign>(await request(`/campaigns/${view.campaignId}`, undefined, 'GET'), 200)).toEqual(parent);
    expect((await getVersion(view.id, 'video', firstVideo.id)).comments).toEqual([firstComment]);
    expect((await getVersion(view.id, 'video', firstVideo.id)).approvedAt).toBe(firstVideo.approvedAt);
    expect((await getVersion(view.id, 'video', secondVideo.id)).comments).toEqual([secondComment]);
    await conflict(view.id, ['video']);
    view = await approveVersion(view.id, 'video', secondVideo.id);
    expect(view.status).toBe('in_production');
    view = await approveDelivery(view.id);
    expect(view.status).toBe('approved');
    db.close();
    db = createDatabase(file);
    app = createApp({ db, now: () => new Date(time) });
    expect(await getDelivery(view.id)).toEqual(view);
    const next = await upload(view.id, 'video', 'third after restart');
    expect(current(next, 'video').number).toBe(3);
    expect(next.status).toBe('in_production');
    expect(next.approvedAt).toBeNull();
  });

  it('a delayed upload body does not hold a transaction or reuse stale delivery approval state', async () => {
    const view = await ready();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const streamingRequest = new Request(`http://localhost/deliveries/${view.id}/pieces/video/versions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const delayed = app.fetch(streamingRequest);
    // Give the route a chance to begin reading its incomplete body.
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      const approved = await approveDelivery(view.id);
      expect(approved.status).toBe('approved');
      tick();
    } finally {
      controller.enqueue(new TextEncoder().encode('{"content":"delayed replacement"}'));
      controller.close();
    }
    const reopened = await result<Delivery>(await delayed, 201);
    expect(reopened.status).toBe('in_production');
    expect(reopened.approvedAt).toBeNull();
    expect(reopened.pendingPieces).toEqual(['video']);
    expect(current(reopened, 'video').number).toBe(2);
    expect(current(reopened, 'video').content).toBe('delayed replacement');
    await conflict(view.id, ['video']);
  });

  it('a delayed malformed upload leaves an intervening delivery approval untouched', async () => {
    const view = await ready();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const delayed = app.fetch(new Request(`http://localhost/deliveries/${view.id}/pieces/video/versions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half',
    } as RequestInit & { duplex: 'half' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    let approved!: Delivery;
    try {
      approved = await approveDelivery(view.id);
    } finally {
      controller.enqueue(new TextEncoder().encode('{"content":'));
      controller.close();
    }
    expect((await delayed).status).toBe(400);
    expect(await getDelivery(view.id)).toEqual(approved);
  });

  it('delayed uploads allocate versions from current database state, not pre-body snapshots', async () => {
    const view = await delivery();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const delayed = app.fetch(new Request(`http://localhost/deliveries/${view.id}/pieces/video/versions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half',
    } as RequestInit & { duplex: 'half' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      const fast = await upload(view.id, 'video', 'fast upload');
      expect(current(fast, 'video').number).toBe(1);
    } finally {
      controller.enqueue(new TextEncoder().encode('{"content":"slow upload"}'));
      controller.close();
    }
    const completed = await result<Delivery>(await delayed, 201);
    expect(completed.pieces[0].versions.map((version) => [version.number, version.content])).toEqual([
      [1, 'fast upload'], [2, 'slow upload'],
    ]);
    expect(current(completed, 'video').number).toBe(2);
  });
});
