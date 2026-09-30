import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  signInWithPopup, 
  signInWithRedirect,
  getRedirectResult,
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

const baseProvider = new GoogleAuthProvider();
baseProvider.setCustomParameters({ prompt: 'select_account' });

export const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file'
];

const sheetsProvider = new GoogleAuthProvider();
SCOPES.forEach(scope => sheetsProvider.addScope(scope));
sheetsProvider.setCustomParameters({ prompt: 'consent' });

let isSigningIn = false;
let cachedAccessToken: string | null = null;
let cachedGoogleOAuthToken: string | null = null;

export const initAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void
) => {
  // Capture redirect result if user came back from Google redirect
  getRedirectResult(auth)
    .then(async (result) => {
      if (result?.user) {
        const token = await result.user.getIdToken();
        const credential = GoogleAuthProvider.credentialFromResult(result);
        if (credential?.accessToken) {
          cachedGoogleOAuthToken = credential.accessToken;
        }
        cachedAccessToken = token;
        if (onAuthSuccess) onAuthSuccess(result.user, token);
      }
    })
    .catch((err) => {
      console.warn('Redirect sign in error:', err);
    });

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

export const googleSignIn = async (requestSheetsScopes: boolean = false): Promise<{ user: User; accessToken: string; googleOAuthToken?: string } | null> => {
  try {
    isSigningIn = true;
    const providerToUse = requestSheetsScopes ? sheetsProvider : baseProvider;
    let result;
    try {
      result = await signInWithPopup(auth, providerToUse);
    } catch (popupErr: any) {
      if (popupErr?.code === 'auth/popup-blocked') {
        console.info('Popup blocked, attempting redirect sign-in...');
        await signInWithRedirect(auth, providerToUse);
        return null;
      }
      throw popupErr;
    }

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
    console.error('Google Sign In error:', error);
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
