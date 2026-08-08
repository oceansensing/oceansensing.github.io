/* Where a reader's own overlays are kept between visits.
 *
 * IndexedDB rather than localStorage, and not a close call: localStorage holds
 * strings, so a KMZ would have to be base64'd — a third larger — inside a
 * quota of about 5 MB. One survey plan of any size would fill it. IndexedDB
 * takes the bytes as they are and its allowance is orders of magnitude larger.
 *
 * Records are scoped by the map's storageKey, so two maps on a page keep
 * separate overlays for the same reason they keep separate saved views.
 *
 * Every call resolves rather than rejects. A reader in private browsing, or
 * one who has denied storage, should get a map that draws and forgets — not a
 * map that fails to start.
 */

const DB = 'ocean-map';
const STORE = 'overlays';
const VERSION = 1;

export interface StoredOverlay {
  /** Unique per record; also the Leaflet layer's identity in the switcher. */
  id: string;
  /** Which map instance this belongs to. */
  mapKey: string;
  /** The file's own name, shown in the layer switcher. */
  name: string;
  /** The file exactly as it was handed over — .kmz, .kml, .geojson, .shp,
      or a .zip. A loose shapefile set is bundled into a ZIP on the way in
      (see `bundleParts`), so one record is still one blob and this field
      did not have to grow into a list. */
  bytes: ArrayBuffer;
  added: number;
}

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB, VERSION);
    } catch {
      return resolve(null);
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' }).createIndex('mapKey', 'mapKey');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return open().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        let request: IDBRequest<T>;
        try {
          request = work(db.transaction(STORE, mode).objectStore(STORE));
        } catch {
          db.close();
          return resolve(null);
        }
        request.onsuccess = () => {
          resolve(request.result);
          db.close();
        };
        request.onerror = () => {
          resolve(null);
          db.close();
        };
      })
  );
}

/** Everything this map instance has stored, oldest first. */
export async function listOverlays(mapKey: string): Promise<StoredOverlay[]> {
  const all = (await run<StoredOverlay[]>('readonly', (s) => s.getAll())) ?? [];
  return all.filter((o) => o.mapKey === mapKey).sort((a, b) => a.added - b.added);
}

export async function saveOverlay(record: StoredOverlay): Promise<boolean> {
  return (await run('readwrite', (s) => s.put(record))) !== null;
}

export async function removeOverlay(id: string): Promise<void> {
  await run('readwrite', (s) => s.delete(id));
}
