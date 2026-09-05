(() => {
  "use strict";

  const cfg = window.CENTRAL_SYNC_CONFIG || {};
  if (!cfg.appId) return;

  const SDK_VERSION = "12.17.1";
  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyA8zLyzYwRv3qDIw-8H4_Tesy8iiH1haaA",
    authDomain: "central-de-apps.firebaseapp.com",
    projectId: "central-de-apps",
    storageBucket: "central-de-apps.firebasestorage.app",
    messagingSenderId: "222066712643",
    appId: "1:222066712643:web:130c3d5ebc5c4b935d74f6",
    measurementId: "G-44P6G2ZSE3"
  };

  const APP_ID = String(cfg.appId).replace(/[^a-zA-Z0-9_-]/g, "-");
  const WATCH_KEYS = new Set((cfg.localStorageKeys || []).map(String));
  const IDB_SPECS = Array.isArray(cfg.indexedDB) ? cfg.indexedDB : [];
  const META_KEY = `central-cloud-sync-meta-v2:${APP_ID}`;
  const CHUNK_CHARS = 180000;
  const DEBOUNCE_MS = Math.max(800, Number(cfg.debounceMs || 1600));

  let user = null;
  let db = null;
  let fs = null;
  let ready = false;
  let initializing = true;
  let pushTimer = null;
  let pushRunning = false;
  let queuedAfterPush = false;
  let applyingRemote = false;

  const nativeSetItem = Storage.prototype.setItem;
  const nativeRemoveItem = Storage.prototype.removeItem;
  const nativeClear = Storage.prototype.clear;

  function rawSet(key, value) {
    nativeSetItem.call(localStorage, key, value);
  }

  function readMeta() {
    try {
      return JSON.parse(localStorage.getItem(META_KEY) || "{}") || {};
    } catch {
      return {};
    }
  }

  function writeMeta(patch) {
    const next = { ...readMeta(), ...patch };
    try { rawSet(META_KEY, JSON.stringify(next)); } catch {}
    return next;
  }

  function markLocalChange() {
    if (applyingRemote) return;
    writeMeta({ localUpdatedAt: Date.now() });
    if (!initializing) queuePush();
  }

  Storage.prototype.setItem = function(key, value) {
    nativeSetItem.call(this, key, value);
    if (this === localStorage && WATCH_KEYS.has(String(key))) markLocalChange();
  };

  Storage.prototype.removeItem = function(key) {
    nativeRemoveItem.call(this, key);
    if (this === localStorage && WATCH_KEYS.has(String(key))) markLocalChange();
  };

  Storage.prototype.clear = function() {
    const shouldSync = this === localStorage && WATCH_KEYS.size > 0;
    nativeClear.call(this);
    if (shouldSync) markLocalChange();
  };

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function ensureStore(dbObj, spec) {
    if (dbObj.objectStoreNames.contains(spec.storeName)) return;
    const opts = spec.keyPath ? { keyPath: spec.keyPath } : undefined;
    dbObj.createObjectStore(spec.storeName, opts);
  }

  function openDbOnce(spec, version) {
    return new Promise((resolve, reject) => {
      const req = version ? indexedDB.open(spec.dbName, version) : indexedDB.open(spec.dbName);
      req.onupgradeneeded = () => ensureStore(req.result, spec);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error(`Falha ao abrir ${spec.dbName}`));
      req.onblocked = () => reject(new Error(`${spec.dbName} bloqueado por outra aba`));
    });
  }

  async function openDb(spec) {
    let dbObj = await openDbOnce(spec);
    if (dbObj.objectStoreNames.contains(spec.storeName)) return dbObj;
    const nextVersion = dbObj.version + 1;
    dbObj.close();
    return openDbOnce(spec, nextVersion);
  }

  async function idbRead(spec) {
    const dbObj = await openDb(spec);
    try {
      return await new Promise((resolve, reject) => {
        const tx = dbObj.transaction(spec.storeName, "readonly");
        const store = tx.objectStore(spec.storeName);
        const req = spec.mode === "single" ? store.get(spec.key) : store.getAll();
        req.onsuccess = () => resolve(req.result ?? (spec.mode === "single" ? null : []));
        req.onerror = () => reject(req.error || tx.error);
      });
    } finally {
      try { dbObj.close(); } catch {}
    }
  }

  async function idbWrite(spec, value) {
    const dbObj = await openDb(spec);
    try {
      await new Promise((resolve, reject) => {
        const tx = dbObj.transaction(spec.storeName, "readwrite");
        const store = tx.objectStore(spec.storeName);

        if (spec.mode === "single") {
          if (value == null) store.delete(spec.key);
          else if (spec.keyPath) store.put(value);
          else store.put(value, spec.key);
        } else {
          store.clear();
          for (const item of Array.isArray(value) ? value : []) store.put(item);
        }

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("Gravação IndexedDB cancelada"));
      });
    } finally {
      try { dbObj.close(); } catch {}
    }
  }

  async function buildSnapshot() {
    const local = {};
    for (const key of WATCH_KEYS) {
      const value = localStorage.getItem(key);
      if (value !== null) local[key] = value;
    }

    const idb = {};
    for (const spec of IDB_SPECS) {
      try {
        idb[spec.id || `${spec.dbName}:${spec.storeName}`] = await idbRead(spec);
      } catch (err) {
        console.warn("Central Sync IndexedDB:", err);
      }
    }

    return {
      format: 2,
      appId: APP_ID,
      localStorage: local,
      indexedDB: idb
    };
  }

  function snapshotHasData(snapshot) {
    if (Object.keys(snapshot?.localStorage || {}).length) return true;
    for (const value of Object.values(snapshot?.indexedDB || {})) {
      if (Array.isArray(value) ? value.length > 0 : value != null) return true;
    }
    return false;
  }

  async function applySnapshot(snapshot) {
    applyingRemote = true;
    try {
      const remoteLocal = snapshot?.localStorage || {};

      for (const key of WATCH_KEYS) {
        if (Object.prototype.hasOwnProperty.call(remoteLocal, key)) {
          nativeSetItem.call(localStorage, key, remoteLocal[key]);
        } else {
          nativeRemoveItem.call(localStorage, key);
        }
      }

      const remoteIdb = snapshot?.indexedDB || {};
      for (const spec of IDB_SPECS) {
        const id = spec.id || `${spec.dbName}:${spec.storeName}`;
        await idbWrite(
          spec,
          Object.prototype.hasOwnProperty.call(remoteIdb, id)
            ? remoteIdb[id]
            : (spec.mode === "single" ? null : [])
        );
      }
    } finally {
      applyingRemote = false;
    }
  }

  async function sha256(text) {
    try {
      const bytes = new TextEncoder().encode(text);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
    } catch {
      let h = 2166136261;
      for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return `f${(h >>> 0).toString(16)}`;
    }
  }

  function splitChunks(text) {
    const chunks = [];
    for (let i = 0; i < text.length; i += CHUNK_CHARS) chunks.push(text.slice(i, i + CHUNK_CHARS));
    return chunks.length ? chunks : [""];
  }

  function rootRef() {
    return fs.doc(db, "usuarios", user.uid, "apps", APP_ID);
  }

  function chunksCol() {
    return fs.collection(db, "usuarios", user.uid, "apps", APP_ID, "chunks");
  }

  async function pullCloud() {
    const root = await fs.getDoc(rootRef());
    if (!root.exists()) return null;

    const meta = root.data() || {};
    const count = Math.max(0, Number(meta.chunkCount || 0));
    const snap = await fs.getDocs(chunksCol());

    const pieces = snap.docs
      .map(d => ({ id: d.id, ...(d.data() || {}) }))
      .filter(x => Number.isFinite(Number(x.index)) && Number(x.index) < count)
      .sort((a, b) => Number(a.index) - Number(b.index));

    if (pieces.length !== count) throw new Error("Backup da nuvem incompleto");

    const text = pieces.map(x => String(x.data || "")).join("");
    const hash = await sha256(text);

    if (meta.payloadHash && hash !== meta.payloadHash) {
      throw new Error("Integridade do backup da nuvem inválida");
    }

    return {
      snapshot: JSON.parse(text || "{}"),
      hash,
      clientUpdatedAt: Number(meta.clientUpdatedAt || 0)
    };
  }

  async function pushCloud() {
    if (!ready || !user || !navigator.onLine || applyingRemote) return;

    if (pushRunning) {
      queuedAfterPush = true;
      return;
    }

    pushRunning = true;

    try {
      const snapshot = await buildSnapshot();
      const text = JSON.stringify(snapshot);
      const hash = await sha256(text);
      const chunks = splitChunks(text);
      const existing = await fs.getDocs(chunksCol());
      const keep = new Set();

      for (let i = 0; i < chunks.length; i++) {
        const id = String(i).padStart(5, "0");
        keep.add(id);

        await fs.setDoc(fs.doc(chunksCol(), id), {
          index: i,
          data: chunks[i]
        });
      }

      for (const d of existing.docs) {
        if (!keep.has(d.id)) await fs.deleteDoc(d.ref);
      }

      const clientUpdatedAt = Date.now();

      await fs.setDoc(rootRef(), {
        appId: APP_ID,
        syncVersion: 2,
        chunkCount: chunks.length,
        payloadHash: hash,
        bytesApprox: new Blob([text]).size,
        clientUpdatedAt,
        updatedAt: fs.serverTimestamp()
      }, { merge: true });

      writeMeta({
        localUpdatedAt: clientUpdatedAt,
        lastCloudHash: hash,
        lastSyncAt: clientUpdatedAt
      });

      window.dispatchEvent(new CustomEvent("central-sync-success", {
        detail: { appId: APP_ID, direction: "push" }
      }));
    } catch (err) {
      console.warn(`Central Sync (${APP_ID}) envio:`, err);

      window.dispatchEvent(new CustomEvent("central-sync-error", {
        detail: {
          appId: APP_ID,
          error: String(err?.code || err?.message || err)
        }
      }));
    } finally {
      pushRunning = false;

      if (queuedAfterPush) {
        queuedAfterPush = false;
        queuePush();
      }
    }
  }

  function queuePush() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => pushCloud(), DEBOUNCE_MS);
  }

  async function reconcile() {
    if (!user || !navigator.onLine) {
      initializing = false;
      return;
    }

    try {
      const localSnapshot = await buildSnapshot();
      const localHasData = snapshotHasData(localSnapshot);
      const meta = readMeta();
      const remote = await pullCloud();

      if (!remote) {
        initializing = false;
        if (localHasData) await pushCloud();
        return;
      }

      const localUpdatedAt = Number(meta.localUpdatedAt || 0);
      const sameKnownCloud =
        meta.lastCloudHash &&
        meta.lastCloudHash === remote.hash;

      if (sameKnownCloud) {
        initializing = false;
        return;
      }

      if (localHasData && localUpdatedAt > remote.clientUpdatedAt) {
        initializing = false;
        await pushCloud();
        return;
      }

      await applySnapshot(remote.snapshot);

      writeMeta({
        localUpdatedAt: remote.clientUpdatedAt || Date.now(),
        lastCloudHash: remote.hash,
        lastSyncAt: Date.now()
      });

      initializing = false;

      window.dispatchEvent(new CustomEvent("central-sync-success", {
        detail: { appId: APP_ID, direction: "pull" }
      }));

      const reloadKey = `central-cloud-sync-reloaded-v2:${APP_ID}`;

      if (sessionStorage.getItem(reloadKey) !== remote.hash) {
        sessionStorage.setItem(reloadKey, remote.hash);
        location.reload();
      }
    } catch (err) {
      initializing = false;
      console.warn(`Central Sync (${APP_ID}) leitura:`, err);

      window.dispatchEvent(new CustomEvent("central-sync-error", {
        detail: {
          appId: APP_ID,
          error: String(err?.code || err?.message || err)
        }
      }));
    }
  }

  window.CentralSync = {
    status: () => ({
      appId: APP_ID,
      ready,
      signedIn: !!user,
      online: navigator.onLine,
      syncing: pushRunning
    }),
    markDirty: () => markLocalChange(),
    syncNow: async () => {
      markLocalChange();
      return pushCloud();
    }
  };

  (async () => {
    try {
      await sleep(450);

      const [appMod, authMod, firestoreMod] = await Promise.all([
        import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-app.js`),
        import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-auth.js`),
        import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-firestore.js`)
      ]);

      let app;

      try {
        app = appMod.getApp();

        if (app.options?.projectId !== FIREBASE_CONFIG.projectId) {
          throw new Error("firebase-project-conflict");
        }
      } catch (err) {
        if (String(err?.message || "").includes("firebase-project-conflict")) throw err;
        app = appMod.initializeApp(FIREBASE_CONFIG);
      }

      const auth = authMod.getAuth(app);
      db = firestoreMod.getFirestore(app);
      fs = firestoreMod;

      authMod.onAuthStateChanged(auth, async current => {
        const oldUid = user?.uid || null;
        user = current || null;
        ready = true;

        if (!user) {
          initializing = false;
          return;
        }

        if (oldUid !== user.uid || initializing) {
          await reconcile();
        }
      });

      window.addEventListener("online", () => {
        if (user) reconcile();
      });
    } catch (err) {
      initializing = false;
      console.warn(`Central Sync (${APP_ID}) não iniciado:`, err);
    }
  })();
})();
