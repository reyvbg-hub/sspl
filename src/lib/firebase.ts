import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged, 
  User, 
  signOut
} from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

const firestoreConfig = {
  ...firebaseConfig,
  projectId: (firebaseConfig as any).firestoreProjectId || 'gen-lang-client-0524948767'
};
const firestoreApp = initializeApp(firestoreConfig, 'firestoreApp');
export const db = getFirestore(
  firestoreApp, 
  (firebaseConfig as any).firestoreDatabaseId || 'ai-studio-f10e7f9b-44b1-4d9a-b58b-6f63b186fa9d'
);

const provider = new GoogleAuthProvider();

export const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file'
];

SCOPES.forEach(scope => provider.addScope(scope));

let isSigningIn = false;
let cachedAccessToken: string | null = null;
let cachedGoogleOAuthToken: string | null = null;

export const initAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      try {
        const token = await user.getIdToken();
        cachedAccessToken = token;
        if (onAuthSuccess) onAuthSuccess(user, token);
      } catch (err) {
        if (onAuthSuccess) onAuthSuccess(user, '');
      }
    } else {
      cachedAccessToken = null;
      cachedGoogleOAuthToken = null;
      if (onAuthFailure) onAuthFailure();
    }
  });
};

export const googleSignIn = async (): Promise<{ user: User; accessToken: string; googleOAuthToken?: string } | null> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const token = credential?.accessToken || await result.user.getIdToken();

    cachedAccessToken = token;
    if (credential?.accessToken) {
      cachedGoogleOAuthToken = credential.accessToken;
    }

    return { 
      user: result.user, 
      accessToken: cachedAccessToken,
      googleOAuthToken: cachedGoogleOAuthToken || undefined 
    };
  } catch (error: any) {
    if (error.code !== 'auth/popup-closed-by-user' && error.code !== 'auth/cancelled-popup-request') {
      console.error('Sign in error:', error);
    }
    throw error;
  } finally {
    isSigningIn = false;
  }
};

export const getAccessToken = async (): Promise<string | null> => {
  return cachedAccessToken;
};

export const getGoogleOAuthToken = (): string | null => {
  return cachedGoogleOAuthToken;
};

export const setGoogleOAuthToken = (token: string | null) => {
  cachedGoogleOAuthToken = token;
};

export const logout = async () => {
  await signOut(auth);
  cachedAccessToken = null;
  cachedGoogleOAuthToken = null;
};
