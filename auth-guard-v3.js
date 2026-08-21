(() => {
  "use strict";

  const FIREBASE_SDK_VERSION = "12.17.1";
  const CENTRAL_URL = "https://kaua212106.github.io/Central-de-apps/";
  const DEVICE_KEY = "central-device-id-v1";
  const CENTRAL_GUARD_SESSION_KEY = "central-verified-session-v2";
  const OFFLINE_AUTH_KEY = "central-offline-auth-v3";
  const OFFLINE_AUTH_DURATION = 7 * 24 * 60 * 60 * 1000;

  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyA8zLyzYwRv3qDIw-8H4_Tesy8iiH1haaA",
    authDomain: "central-de-apps.firebaseapp.com",
    projectId: "central-de-apps",
    storageBucket: "central-de-apps.firebasestorage.app",
    messagingSenderId: "222066712643",
    appId: "1:222066712643:web:130c3d5ebc5c4b935d74f6",
    measurementId: "G-44P6G2ZSE3"
  };

  let auth = null;
  let db = null;
  let api = null;
  let checking = false;
  let firebaseReady = false;
  let initialAccessCheckHandled = false;

  function deviceId(){
    let id = "";
    try { id = localStorage.getItem(DEVICE_KEY) || ""; } catch {}

    if(!id){
      id = (
        crypto.randomUUID?.() ||
        ("dev-" + Date.now() + "-" + Math.random().toString(36).slice(2))
      ).replace(/[^a-zA-Z0-9_-]/g,"");

      try { localStorage.setItem(DEVICE_KEY,id); } catch {}
    }

    return id;
  }

  function getJson(key){
    try{
      const raw = localStorage.getItem(key);
      if(!raw) return null;
      const data = JSON.parse(raw);
      return data && typeof data === "object" ? data : null;
    }catch{
      return null;
    }
  }

  function getCentralSession(){
    return getJson(CENTRAL_GUARD_SESSION_KEY);
  }

  function getOfflineGrant(){
    return getJson(OFFLINE_AUTH_KEY);
  }

  function saveOfflineGrant(user){
    const now = Date.now();

    try{
      localStorage.setItem(OFFLINE_AUTH_KEY,JSON.stringify({
        uid: user.uid,
        deviceId: deviceId(),
        verifiedAt: now,
        expiresAt: now + OFFLINE_AUTH_DURATION
      }));
    }catch{}
  }

  function clearOfflineGrant(){
    try{ localStorage.removeItem(OFFLINE_AUTH_KEY) }catch{}
  }

  function offlineGrantIsValid(){
    const session = getCentralSession();
    const grant = getOfflineGrant();
    const currentDevice = deviceId();

    if(!session || !grant) return false;
    if(!session.uid || !grant.uid) return false;
    if(session.uid !== grant.uid) return false;
    if(session.deviceId !== currentDevice) return false;
    if(grant.deviceId !== currentDevice) return false;
    if(typeof grant.expiresAt !== "number") return false;
    if(Date.now() >= grant.expiresAt) return false;

    return true;
  }

  function escapeHtml(v){
    return String(v ?? "").replace(/[&<>"']/g,m=>({
      "&":"&amp;",
      "<":"&lt;",
      ">":"&gt;",
      '"':"&quot;",
      "'":"&#039;"
    }[m]));
  }

  function showLoading(text="Verificando acesso..."){
    document.documentElement.classList.add("central-guard-lock");

    let el = document.getElementById("centralGuardLoading");
    if(!el){
      el = document.createElement("div");
      el.id = "centralGuardLoading";
      el.innerHTML = `
        <div class="central-guard-loading-box">
          <div class="central-guard-spinner"></div>
          <b>${escapeHtml(text)}</b>
          <small>Confirmando sua autorização na Central.</small>
        </div>`;
      document.documentElement.appendChild(el);
    }else{
      const b = el.querySelector("b");
      if(b) b.textContent = text;
    }
  }

  function hideLoading(){
    document.getElementById("centralGuardLoading")?.remove();
  }

  function allowApp(){
    hideLoading();
    document.getElementById("centralGuardBlocked")?.remove();
    document.documentElement.classList.remove("central-guard-lock");
  }

  function blockApp(title,message){
    hideLoading();
    document.documentElement.classList.remove("central-guard-lock");

    document.body.innerHTML = `
      <div id="centralGuardBlocked">
        <div class="central-guard-block-box">
          <div class="central-guard-lock-icon">🔐</div>
          <h2>${escapeHtml(title)}</h2>
          <p>${escapeHtml(message)}</p>
          <button id="centralGuardOpenCentral">Abrir Central</button>
          <small>Proteção da Central • V4</small>
        </div>
      </div>`;

    document.getElementById("centralGuardOpenCentral").onclick = () => {
      location.href = CENTRAL_URL;
    };
  }

  function checkOfflineAccess(){
    showLoading("Verificando acesso offline...");

    if(offlineGrantIsValid()){
      allowApp();
      return true;
    }

    blockApp(
      "Conecte-se à internet",
      "A autorização offline expirou ou ainda não foi criada. Abra a Central com internet para renovar o acesso por mais 7 dias."
    );
    return false;
  }

  async function verifyOnline(user){
    if(checking) return;
    checking = true;

    try{
      showLoading("Verificando acesso...");

      if(!user){
        clearOfflineGrant();
        blockApp(
          "Acesso pela Central",
          "Você não está conectado. Abra a Central, entre na sua conta e tente novamente."
        );
        return;
      }

      const session = getCentralSession();

      if(
        !session ||
        session.uid !== user.uid ||
        session.deviceId !== deviceId()
      ){
        clearOfflineGrant();
        blockApp(
          "Acesso pela Central",
          "Abra a Central e entre novamente antes de acessar este aplicativo."
        );
        return;
      }

      await user.getIdToken(true);

      const userSnap = await api.getDoc(
        api.doc(db,"usuarios",user.uid)
      );

      if(
        !userSnap.exists() ||
        userSnap.data().ativo !== true ||
        userSnap.data().bloqueado === true
      ){
        clearOfflineGrant();
        blockApp(
          "Acesso não autorizado",
          "Sua conta não possui autorização ativa para acessar os aplicativos."
        );
        return;
      }

      const token = await user.getIdTokenResult(true);
      const isAdmin = token.claims?.admin === true;

      if(!isAdmin){
        const deviceSnap = await api.getDoc(
          api.doc(db,"usuarios",user.uid,"dispositivos",deviceId())
        );

        if(
          !deviceSnap.exists() ||
          deviceSnap.data().ativo !== true ||
          deviceSnap.data().bloqueado === true
        ){
          clearOfflineGrant();
          blockApp(
            "Dispositivo não autorizado",
            "Este celular ou navegador ainda não está autorizado pela Central."
          );
          return;
        }
      }

      saveOfflineGrant(user);
      allowApp();

    }catch(err){
      console.error("Central Auth Guard V4:",err);

      // Se a consulta online falhar de verdade, ainda tenta a autorização
      // offline já salva, desde que esteja dentro dos 7 dias.
      if(offlineGrantIsValid()){
        allowApp();
      }else{
        blockApp(
          "Não foi possível verificar o acesso",
          "A verificação online falhou e não existe uma autorização offline válida. Abra a Central quando a conexão estiver disponível."
        );
      }
    }finally{
      checking = false;
    }
  }

  async function initFirebase(){
    if(firebaseReady) return;

    const v = FIREBASE_SDK_VERSION;
    const [appM,authM,fsM] = await Promise.all([
      import(`https://www.gstatic.com/firebasejs/${v}/firebase-app.js`),
      import(`https://www.gstatic.com/firebasejs/${v}/firebase-auth.js`),
      import(`https://www.gstatic.com/firebasejs/${v}/firebase-firestore.js`)
    ]);

    let app;

    try{
      app = appM.getApp();

      if(app.options?.projectId !== FIREBASE_CONFIG.projectId){
        throw new Error("firebase-project-conflict");
      }
    }catch(err){
      if(String(err?.message || "").includes("firebase-project-conflict")){
        throw err;
      }

      app = appM.initializeApp(FIREBASE_CONFIG);
    }

    auth = authM.getAuth(app);
    db = fsM.getFirestore(app);
    api = {...authM,...fsM};
    firebaseReady = true;

    authM.onAuthStateChanged(auth,user=>{
      if(initialAccessCheckHandled) return;
      initialAccessCheckHandled = true;

      if(navigator.onLine){
        verifyOnline(user);
      }else{
        checkOfflineAccess();
      }
    });
  }

  async function evaluate(){
    if(!navigator.onLine){
      checkOfflineAccess();
      return;
    }

    try{
      showLoading();
      await initFirebase();

      // A primeira emissão do onAuthStateChanged fará a única verificação deste carregamento.
    }catch(err){
      console.error("Central Auth Guard V4 init:",err);

      if(offlineGrantIsValid()){
        allowApp();
      }else{
        blockApp(
          "Proteção não iniciada",
          "Não foi possível iniciar a verificação de segurança deste aplicativo."
        );
      }
    }
  }


  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded",evaluate,{once:true});
  }else{
    evaluate();
  }
})();
