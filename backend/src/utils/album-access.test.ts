import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express, { type Express, type Request, type Router } from 'express';

const dataDir = mkdtempSync(path.join(tmpdir(), 'galleria-album-access-'));
const appRoot = path.join(dataDir, 'app-root');
const photosDir = path.join(dataDir, 'photos');
process.env.DATA_DIR = dataDir;

interface AccessResult {
  allowed: boolean;
  exists: boolean;
  reason: string;
}

interface AlbumAccessModule {
  getAlbumAccess(req: Request, albumName: string): AccessResult;
}

interface RequestOptions {
  authenticated?: boolean;
  key?: string;
}

let albumAccess: AlbumAccessModule;
let imageMetadataRouter: Router;
let previewGridRouter: Router;
let albumsRouter: Router;
let generateStaticJSONFiles: (appRoot: string) => Promise<{ success: boolean; error?: string; albumCount?: number }>;
let shareKey = '';
let expiredShareKey = '';

function request(options: RequestOptions = {}): Request {
  return {
    isAuthenticated: () => Boolean(options.authenticated),
    session: options.authenticated ? { userId: 1 } : {},
    query: options.key ? { key: options.key } : {},
  } as unknown as Request;
}

function createRouteApp(): Express {
  const app = express();

  app.set('photosDir', photosDir);
  app.set('appRoot', appRoot);
  app.use((req, _res, next) => {
    const authenticated = req.get('x-test-auth') === '1';
    (req as any).isAuthenticated = () => authenticated;
    (req as any).session = authenticated ? { userId: 1 } : {};
    next();
  });
  app.use('/api/image-metadata', imageMetadataRouter);
  app.use('/api/preview-grid', previewGridRouter);
  app.use(albumsRouter);

  return app;
}

async function withRouteApp(assertions: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = createRouteApp();
  const server = app.listen(0);

  await once(server, 'listening');

  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    await assertions(`http://127.0.0.1:${(address as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
}

async function fetchRoute(baseUrl: string, pathname: string, options: { authenticated?: boolean } = {}): Promise<Response> {
  const headers: Record<string, string> = {};

  if (options.authenticated) {
    headers['x-test-auth'] = '1';
  }

  return fetch(`${baseUrl}${pathname}`, { headers });
}

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

test.before(async () => {
  mkdirSync(path.join(photosDir, 'Published'), { recursive: true });
  mkdirSync(path.join(photosDir, 'Private'), { recursive: true });
  mkdirSync(appRoot, { recursive: true });
  writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    environment: {
      frontend: { port: 3000, apiUrl: 'http://localhost:3000' },
      backend: { port: 3001, allowedOrigins: ['http://localhost:3000'] },
      security: { allowedHosts: ['localhost:3000'], rateLimitWindowMs: 1000, rateLimitMaxRequests: 100 },
      logging: { level: 'error' },
      auth: {
        google: { enabled: false, clientId: '', clientSecret: '' },
        sessionSecret: 'test-session-secret',
        authorizedEmails: [],
      },
    },
    branding: { avatarPath: '/photos/avatar.png' },
    analytics: { enabled: false, openobserve: {} },
    externalLinks: [],
  }));

  const sharp = (await import('sharp')).default;
  await Promise.all([
    sharp({ create: { width: 4, height: 4, channels: 3, background: '#ffffff' } }).jpeg().toFile(path.join(photosDir, 'Published', 'published.jpg')),
    sharp({ create: { width: 4, height: 4, channels: 3, background: '#111111' } }).jpeg().toFile(path.join(photosDir, 'Private', 'private.jpg')),
  ]);

  const database = await import('../database.js');
  albumAccess = await import('./album-access.js');
  imageMetadataRouter = (await import('../routes/image-metadata.js')).default;
  previewGridRouter = (await import('../routes/preview-grid.js')).default;
  albumsRouter = (await import('../routes/albums.js')).default;
  ({ generateStaticJSONFiles } = await import('../routes/static-json.js'));

  database.initializeDatabase();
  database.saveAlbum('Published', true);
  database.saveAlbum('Private', false);
  database.saveAlbum('OtherPrivate', false);
  database.saveImageMetadata('Published', 'published.jpg', 'Published Photo', 'Public description');
  database.saveImageMetadata('Published', 'published-video.mp4', 'Published Video', 'Public video', 'video');
  database.saveImageMetadata('Private', 'private.jpg', 'Private Photo', 'Secret description');
  database.saveImageMetadata('Private', 'private-video.mp4', 'Private Video', 'Secret video', 'video');
  database.saveImageMetadata('OtherPrivate', 'other.jpg', 'Other Private Photo', null);
  shareKey = database.createShareLink('Private', null).secret_key;
  expiredShareKey = database.createShareLink('Private', new Date(Date.now() - 60_000).toISOString()).secret_key;
});

test('allows public access to published albums', () => {
  const access = albumAccess.getAlbumAccess(request(), 'Published');

  assert.equal(access.allowed, true);
  assert.equal(access.reason, 'published');
});

test('denies anonymous access to unpublished albums without a valid share link', () => {
  const access = albumAccess.getAlbumAccess(request(), 'Private');

  assert.equal(access.allowed, false);
  assert.equal(access.exists, true);
  assert.equal(access.reason, 'denied');
});

test('allows authenticated access to unpublished albums', () => {
  const access = albumAccess.getAlbumAccess(request({ authenticated: true }), 'Private');

  assert.equal(access.allowed, true);
  assert.equal(access.reason, 'authenticated');
});

test('allows share-link access only for the matching unexpired album', () => {
  const allowed = albumAccess.getAlbumAccess(request({ key: shareKey }), 'Private');
  const wrongAlbum = albumAccess.getAlbumAccess(request({ key: shareKey }), 'OtherPrivate');
  const expired = albumAccess.getAlbumAccess(request({ key: expiredShareKey }), 'Private');

  assert.equal(allowed.allowed, true);
  assert.equal(allowed.reason, 'share_link');
  assert.equal(wrongAlbum.allowed, false);
  assert.equal(wrongAlbum.reason, 'denied');
  assert.equal(expired.allowed, false);
  assert.equal(expired.reason, 'denied');
});

test('image metadata routes filter or deny unpublished albums unless authenticated or shared', async () => {
  await withRouteApp(async (baseUrl) => {
    const allResponse = await fetchRoute(baseUrl, '/api/image-metadata/all');
    assert.equal(allResponse.status, 200);
    const allMetadata = await allResponse.json() as Array<{ album: string; filename: string }>;
    assert.deepEqual(new Set(allMetadata.map(item => item.album)), new Set(['Published']));

    const sharedAllResponse = await fetchRoute(baseUrl, `/api/image-metadata/all?key=${shareKey}`);
    assert.equal(sharedAllResponse.status, 200);
    const sharedAllMetadata = await sharedAllResponse.json() as Array<{ album: string }>;
    assert.deepEqual(new Set(sharedAllMetadata.map(item => item.album)), new Set(['Private', 'Published']));

    const privateAlbumResponse = await fetchRoute(baseUrl, '/api/image-metadata/album/Private');
    assert.equal(privateAlbumResponse.status, 403);

    const sharedAlbumResponse = await fetchRoute(baseUrl, `/api/image-metadata/album/Private?key=${shareKey}`);
    assert.equal(sharedAlbumResponse.status, 200);
    const sharedAlbumMetadata = await sharedAlbumResponse.json() as Array<{ filename: string }>;
    assert.deepEqual(new Set(sharedAlbumMetadata.map(item => item.filename)), new Set(['private.jpg', 'private-video.mp4']));

    const privateImageResponse = await fetchRoute(baseUrl, '/api/image-metadata/Private/private.jpg');
    assert.equal(privateImageResponse.status, 403);

    const authenticatedImageResponse = await fetchRoute(baseUrl, '/api/image-metadata/Private/private.jpg', { authenticated: true });
    assert.equal(authenticatedImageResponse.status, 200);

    const sharedImageResponse = await fetchRoute(baseUrl, `/api/image-metadata/Private/private.jpg?key=${shareKey}`);
    assert.equal(sharedImageResponse.status, 200);
    const sharedImageMetadata = await sharedImageResponse.json() as { title: string };
    assert.equal(sharedImageMetadata.title, 'Private Photo');
  });
});

test('preview grid route denies unpublished albums anonymously and allows valid share links', async () => {
  await withRouteApp(async (baseUrl) => {
    const anonymousPrivateResponse = await fetchRoute(baseUrl, '/api/preview-grid/album/Private');
    assert.equal(anonymousPrivateResponse.status, 403);

    const publishedResponse = await fetchRoute(baseUrl, '/api/preview-grid/album/Published');
    assert.equal(publishedResponse.status, 200);
    assert.match(publishedResponse.headers.get('content-type') ?? '', /^image\/jpeg/);

    const sharedPrivateResponse = await fetchRoute(baseUrl, `/api/preview-grid/album/Private?key=${shareKey}`);
    assert.equal(sharedPrivateResponse.status, 200);
    assert.match(sharedPrivateResponse.headers.get('content-type') ?? '', /^image\/jpeg/);
  });
});

test('EXIF and video metadata routes check album access before file existence', async () => {
  await withRouteApp(async (baseUrl) => {
    const privateExifResponse = await fetchRoute(baseUrl, '/api/photos/Private/missing.jpg/exif');
    assert.equal(privateExifResponse.status, 403);

    const publishedExifResponse = await fetchRoute(baseUrl, '/api/photos/Published/missing.jpg/exif');
    assert.equal(publishedExifResponse.status, 404);

    const sharedExifResponse = await fetchRoute(baseUrl, `/api/photos/Private/private.jpg/exif?key=${shareKey}`);
    assert.equal(sharedExifResponse.status, 200);

    const privateVideoResponse = await fetchRoute(baseUrl, '/api/videos/Private/missing.mp4/metadata');
    assert.equal(privateVideoResponse.status, 403);

    const authenticatedVideoResponse = await fetchRoute(baseUrl, '/api/videos/Private/missing.mp4/metadata', { authenticated: true });
    assert.equal(authenticatedVideoResponse.status, 404);
  });
});

test('static JSON generation removes stale unpublished album files', async () => {
  const outputDir = path.join(appRoot, 'frontend', 'dist', 'albums-data');
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(path.join(outputDir, 'Private.json'), JSON.stringify([['private.jpg', 'Private Photo']]));

  const result = await generateStaticJSONFiles(appRoot);

  assert.equal(result.success, true);
  assert.equal(result.albumCount, 1);
  assert.equal(existsSync(path.join(outputDir, 'Private.json')), false);
  assert.equal(existsSync(path.join(outputDir, 'Published.json')), true);

  const albumsList = JSON.parse(readFileSync(path.join(outputDir, 'albums-list.json'), 'utf8'));
  assert.deepEqual(albumsList, ['Published']);
});
