// ==========================================================================
// CONFIGURACIÓN DE FIREBASE AUTHENTICATION (CON TUS DATOS REALES)
// ==========================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js";
import { 
    getAuth, 
    GoogleAuthProvider, 
    signInWithPopup, 
    signOut, 
    onAuthStateChanged,
    setPersistence,
    browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js";

// Tus credenciales reales de pccrafter-16388 tomadas de tu captura:
const firebaseConfig = {
    apiKey: "AIzaSyBETImwkFnrHuTYCB4pyKa7yLjutgJWwUM",
    authDomain: "pccrafter-16388.firebaseapp.com",
    projectId: "pccrafter-16388",
    storageBucket: "pccrafter-16388.firebasestorage.app",
    messagingSenderId: "716000344564",
    appId: "1:716000344564:web:c5d8291876d1f8492da1a1",
    measurementId: "G-RF4QQ379SK"
};

// Inicializar Firebase y el servicio de Autenticación
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

// Permitir elegir cuenta de Google siempre
googleProvider.setCustomParameters({
    prompt: 'select_account'
});

export { 
    auth, 
    googleProvider, 
    signInWithPopup, 
    signOut, 
    onAuthStateChanged,
    setPersistence,
    browserLocalPersistence
};