import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Hono, type Context } from 'hono';
import { transaction } from './database.js';

export const pieceKinds = ['script', 'video', 'cover', 'caption'] as const;
export type PieceKind = (typeof pieceKinds)[number];

type Comment = {
  id: string;
  versionId: string;
  second: number;
  text: string;
  createdAt: string;
};
type Version = {
  id: string;
  number: number;
  content: string;
  status: 'in_review' | 'approved';
  approvedAt: string | null;
  createdAt: string;
  isCurrent: boolean;
  comments: Comment[];
};
type Campaign = {
  id: string;
  title: string;
  requiredPieces: PieceKind[];
  createdAt: string;
};
type Delivery = {
  id: string;
  campaignId: string;
  creatorId: string;
  status: 'in_production' | 'approved';
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  requiredPieces: PieceKind[];
  pendingPieces: PieceKind[];
  pieces: { kind: PieceKind; currentVersionId: string; versions: Version[] }[];
};

class ApiError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
    readonly details: { code?: string; pendingPieces?: PieceKind[] } = {},
  ) {
    super(message);
  }
}

function isKind(value: unknown): value is PieceKind {
  return typeof value === 'string' && pieceKinds.includes(value as PieceKind);
}

function nonblank(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiError(400, `${field} deve ser uma string não vazia.`);
  }
  if (value.includes('\u0000')) {
    throw new ApiError(400, `${field} não pode conter o caractere NUL (U+0000).`);
  }
  return value;
}

async function body(c: Context, optional = false): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    const text = await c.req.text();
    value = optional && text.length === 0 ? {} : JSON.parse(text);
  } catch {
    throw new ApiError(400, 'Corpo JSON inválido.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'O corpo deve ser um objeto JSON.');
  }
  return value as Record<string, unknown>;
}

export function createApp({ db, now = () => new Date() }: {
  db: DatabaseSync;
  now?: () => Date;
}) {
  const app = new Hono();
  const timestamp = () => now().toISOString();

  // These state readers are only called from synchronous transactions below.
  function campaign(id: string): Campaign {
    const row = db.prepare('SELECT id, title, created_at AS createdAt FROM campaigns WHERE id = ?')
      .get(id) as { id: string; title: string; createdAt: string } | undefined;
    if (!row) throw new ApiError(404, 'Campanha não encontrada.');
    const required = db.prepare(`
      SELECT kind FROM campaign_required_pieces WHERE campaign_id = ? ORDER BY position
    `).all(id) as { kind: PieceKind }[];
    return { ...row, requiredPieces: required.map((piece) => piece.kind) };
  }

  function delivery(id: string): Delivery {
    const row = db.prepare(`
      SELECT id, campaign_id AS campaignId, creator_id AS creatorId, status,
        approved_at AS approvedAt, created_at AS createdAt, updated_at AS updatedAt
      FROM deliveries WHERE id = ?
    `).get(id) as Omit<Delivery, 'requiredPieces' | 'pendingPieces' | 'pieces'> | undefined;
    if (!row) throw new ApiError(404, 'Entrega não encontrada.');
    const requiredPieces = campaign(row.campaignId).requiredPieces;
    const versions = db.prepare(`
      SELECT id, kind, number, content, status, approved_at AS approvedAt, created_at AS createdAt
      FROM piece_versions WHERE delivery_id = ? ORDER BY number
    `).all(id) as (Omit<Version, 'isCurrent' | 'comments'> & { kind: PieceKind })[];
    const comments = db.prepare(`
      SELECT c.id, c.version_id AS versionId, c.second, c.text, c.created_at AS createdAt
      FROM video_comments c JOIN piece_versions v ON v.id = c.version_id
      WHERE v.delivery_id = ? ORDER BY c.rowid
    `).all(id) as Comment[];
    const commentsByVersion = new Map<string, Comment[]>();
    for (const comment of comments) {
      const list = commentsByVersion.get(comment.versionId) ?? [];
      list.push(comment);
      commentsByVersion.set(comment.versionId, list);
    }
    const pieces: Delivery['pieces'] = [];
    for (const kind of pieceKinds) {
      const history = versions.filter((version) => version.kind === kind);
      if (!history.length) continue;
      const currentVersionId = history[history.length - 1].id;
      pieces.push({
        kind,
        currentVersionId,
        versions: history.map(({ kind: _kind, ...version }) => ({
          ...version,
          isCurrent: version.id === currentVersionId,
          comments: commentsByVersion.get(version.id) ?? [],
        })),
      });
    }
    // Single readiness calculation, shared by the view and delivery approval.
    const pendingPieces = requiredPieces.filter((kind) => {
      const piece = pieces.find((item) => item.kind === kind);
      return !piece || piece.versions[piece.versions.length - 1].status !== 'approved';
    });
    return { ...row, requiredPieces, pendingPieces, pieces };
  }

  function versionIn(view: Delivery, kind: string, versionId: string): Version {
    const version = view.pieces.find((piece) => piece.kind === kind)?.versions
      .find((item) => item.id === versionId);
    if (!version) throw new ApiError(404, 'Versão não encontrada nesta entrega e peça.');
    return version;
  }

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json({ error: error.message, ...error.details }, error.status);
    }
    console.error(error);
    return c.json({ error: 'Erro interno do servidor.' }, 500);
  });
  app.notFound((c) => c.json({ error: 'Rota não encontrada.' }, 404));

  app.post('/campaigns', async (c) => {
    const input = await body(c);
    const title = nonblank(input.title, 'title');
    const required = input.requiredPieces;
    if (!Array.isArray(required) || required.length === 0 || !required.every(isKind)
      || new Set(required).size !== required.length) {
      throw new ApiError(400, 'requiredPieces deve conter peças válidas, únicas e não pode estar vazio.');
    }
    const result = transaction(db, () => {
      const id = randomUUID();
      db.prepare('INSERT INTO campaigns (id, title, created_at) VALUES (?, ?, ?)')
        .run(id, title, timestamp());
      const insert = db.prepare('INSERT INTO campaign_required_pieces (campaign_id, kind, position) VALUES (?, ?, ?)');
      required.forEach((kind, position) => insert.run(id, kind, position));
      return campaign(id);
    });
    return c.json(result, 201);
  });

  app.get('/campaigns/:id', (c) => c.json(transaction(db, () => campaign(c.req.param('id')), 'read')));

  app.post('/deliveries', async (c) => {
    const input = await body(c);
    const campaignId = nonblank(input.campaignId, 'campaignId');
    const creatorId = nonblank(input.creatorId, 'creatorId');
    const result = transaction(db, () => {
      campaign(campaignId);
      const id = randomUUID();
      const at = timestamp();
      db.prepare(`
        INSERT INTO deliveries (id, campaign_id, creator_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, campaignId, creatorId, at, at);
      return delivery(id);
    });
    return c.json(result, 201);
  });

  app.get('/deliveries/:id', (c) => c.json(transaction(db, () => delivery(c.req.param('id')), 'read')));

  app.post('/deliveries/:id/pieces/:kind/versions', async (c) => {
    const input = await body(c);
    const content = nonblank(input.content, 'content');
    const kind = c.req.param('kind');
    if (!isKind(kind)) throw new ApiError(400, 'Tipo de peça inválido.');
    const result = transaction(db, () => {
      const view = delivery(c.req.param('id'));
      const piece = view.pieces.find((item) => item.kind === kind);
      const number = piece ? piece.versions[piece.versions.length - 1].number + 1 : 1;
      const at = timestamp();
      db.prepare(`
        INSERT INTO piece_versions (id, delivery_id, kind, number, content, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), view.id, kind, number, content, at);
      db.prepare(`
        UPDATE deliveries SET status = 'in_production', approved_at = NULL, updated_at = ? WHERE id = ?
      `).run(at, view.id);
      return delivery(view.id);
    });
    return c.json(result, 201);
  });

  app.post('/deliveries/:id/pieces/:kind/versions/:versionId/approval', async (c) => {
    await body(c, true);
    const kind = c.req.param('kind');
    if (!isKind(kind)) throw new ApiError(400, 'Tipo de peça inválido.');
    const result = transaction(db, () => {
      const view = delivery(c.req.param('id'));
      const version = versionIn(view, kind, c.req.param('versionId'));
      if (!version.isCurrent) throw new ApiError(409, 'Somente a versão atual da peça pode ser aprovada.');
      if (version.status === 'approved') return view;
      const at = timestamp();
      db.prepare("UPDATE piece_versions SET status = 'approved', approved_at = ? WHERE id = ?")
        .run(at, version.id);
      db.prepare('UPDATE deliveries SET updated_at = ? WHERE id = ?').run(at, view.id);
      return delivery(view.id);
    });
    return c.json(result);
  });

  app.post('/deliveries/:id/approval', async (c) => {
    await body(c, true);
    const result = transaction(db, () => {
      const view = delivery(c.req.param('id'));
      if (view.pendingPieces.length) {
        throw new ApiError(409, `Peças obrigatórias sem versão atual aprovada: ${view.pendingPieces.join(', ')}.`, {
          code: 'REQUIRED_PIECES_PENDING',
          pendingPieces: view.pendingPieces,
        });
      }
      if (view.status === 'approved') return view;
      const at = timestamp();
      db.prepare("UPDATE deliveries SET status = 'approved', approved_at = ?, updated_at = ? WHERE id = ?")
        .run(at, at, view.id);
      return delivery(view.id);
    });
    return c.json(result);
  });

  app.post('/deliveries/:id/pieces/video/versions/:versionId/comments', async (c) => {
    const input = await body(c);
    const text = nonblank(input.text, 'text');
    const second = input.second;
    if (typeof second !== 'number' || !Number.isFinite(second) || second < 0) {
      throw new ApiError(400, 'second deve ser um número finito não negativo.');
    }
    const result = transaction(db, () => {
      const deliveryId = c.req.param('id');
      const version = db.prepare(`
        SELECT id FROM piece_versions WHERE id = ? AND delivery_id = ? AND kind = 'video'
      `).get(c.req.param('versionId'), deliveryId) as { id: string } | undefined;
      if (!version) throw new ApiError(404, 'Versão não encontrada nesta entrega e peça.');
      const comment: Comment = { id: randomUUID(), versionId: version.id, second, text, createdAt: timestamp() };
      db.prepare('INSERT INTO video_comments (id, version_id, second, text, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(comment.id, comment.versionId, second, text, comment.createdAt);
      db.prepare('UPDATE deliveries SET updated_at = ? WHERE id = ?').run(comment.createdAt, deliveryId);
      return comment;
    });
    return c.json(result, 201);
  });

  app.get('/deliveries/:id/pieces/:kind/versions/:versionId', (c) => c.json(transaction(db, () =>
    versionIn(delivery(c.req.param('id')), c.req.param('kind'), c.req.param('versionId')), 'read')));

  return app;
}
