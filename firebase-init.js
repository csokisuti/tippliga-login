// firebase-init.js — közös Firebase-inicializálás (TippLiga)
//
// Minden oldal innen kapja az app, auth és db példányt:
//   import { app, auth, db } from "./firebase-init.js";
//
// A Firebase-konfiguráció csak itt szerepel. Ha változik (pl. új projekt),
// elég ezt az egy fájlt módosítani.
//
// Az SDK-verzió (10.12.2) egyezzen meg az oldalak importjaiban szereplővel,
// különben két külön Firebase-példány jönne létre.

import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const firebaseConfig = {
  apiKey: "AIzaSyC2xpMW1xgaWIdI2JoEhK23vkC0FTF2PKc",
  authDomain: "tippliga-4b3af.firebaseapp.com",
  projectId: "tippliga-4b3af",
  storageBucket: "tippliga-4b3af.appspot.com",
  messagingSenderId: "720359845241",
  appId: "1:720359845241:web:d3d6edcac6b43ebff053a8"
};

export const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
