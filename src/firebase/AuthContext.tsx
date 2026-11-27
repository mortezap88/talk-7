import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import { auth, googleProvider } from './firebase';
import { firestoreWorkspaceStore } from './firestoreStore';
import { talkApi } from '../api/talkClient';

const LOCAL_MODE_SESSION_KEY = 'talk_local_mode_v1';

interface FirebaseAuthContextValue {
  user: User | null;
  isAuthReady: boolean;
  isSigningIn: boolean;
  authError: string | null;
  localMode: boolean;
  signInWithGoogle: () => Promise<void>;
  signOutUser: () => Promise<void>;
  enterLocalMode: () => void;
  clearAuthError: () => void;
}

const FirebaseAuthContext = createContext<FirebaseAuthContextValue | null>(null);

export function FirebaseProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [localMode, setLocalMode] = useState<boolean>(() => {
    try {
      return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(LOCAL_MODE_SESSION_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (nextUser) => {
      if (nextUser) {
        try {
          await firestoreWorkspaceStore.ensureUserInitialized(nextUser);
          talkApi.setFirebaseUser(nextUser.uid);
          try {
            sessionStorage.removeItem(LOCAL_MODE_SESSION_KEY);
          } catch {
            // ignore storage errors
          }
          setLocalMode(false);
          setUser(nextUser);
          setAuthError(null);
        } catch (err) {
          talkApi.setFirebaseUser(null);
          setUser(null);
          setAuthError(
            err instanceof Error ? err.message : 'Failed to initialize your Firebase workspace.'
          );
        } finally {
          setIsAuthReady(true);
        }
      } else {
        talkApi.setFirebaseUser(null);
        setUser(null);
        setIsAuthReady(true);
      }
    });

    return () => unsubscribe();
  }, []);

  const signInWithGoogle = useCallback(async () => {
    setIsSigningIn(true);
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        setAuthError(null);
      } else if (code === 'auth/popup-blocked') {
        setAuthError('Sign-in popup was blocked by your browser. Please allow popups and try again.');
      } else {
        setAuthError(err instanceof Error ? err.message : 'Google sign-in failed.');
      }
    } finally {
      setIsSigningIn(false);
    }
  }, []);

  const signOutUser = useCallback(async () => {
    setAuthError(null);
    try {
      sessionStorage.removeItem(LOCAL_MODE_SESSION_KEY);
    } catch {
      // ignore
    }
    setLocalMode(false);
    talkApi.setFirebaseUser(null);
    await signOut(auth);
  }, []);

  const enterLocalMode = useCallback(() => {
    setAuthError(null);
    talkApi.setFirebaseUser(null);
    try {
      sessionStorage.setItem(LOCAL_MODE_SESSION_KEY, '1');
    } catch {
      // ignore
    }
    setLocalMode(true);
  }, []);

  const clearAuthError = useCallback(() => setAuthError(null), []);

  return (
    <FirebaseAuthContext.Provider
      value={{
        user,
        isAuthReady,
        isSigningIn,
        authError,
        localMode,
        signInWithGoogle,
        signOutUser,
        enterLocalMode,
        clearAuthError,
      }}
    >
      {children}
    </FirebaseAuthContext.Provider>
  );
}

export function useFirebaseAuth(): FirebaseAuthContextValue {
  const ctx = useContext(FirebaseAuthContext);
  if (!ctx) {
    throw new Error('useFirebaseAuth must be used inside FirebaseProvider');
  }
  return ctx;
}
