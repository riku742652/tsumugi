import {
  signIn as amplifySignIn,
  signOut as amplifySignOut,
  getCurrentUser as amplifyGetCurrentUser,
  fetchAuthSession,
} from 'aws-amplify/auth';

export async function signIn(email: string, password: string): Promise<void> {
  await amplifySignIn({ username: email, password });
}

export async function signOut(): Promise<void> {
  await amplifySignOut();
}

export async function getCurrentUser(): Promise<{ userId: string; email: string } | null> {
  try {
    const user = await amplifyGetCurrentUser();
    return { userId: user.userId, email: user.signInDetails?.loginId ?? '' };
  } catch {
    return null;
  }
}

export async function getIdToken(): Promise<string> {
  const session = await fetchAuthSession({ forceRefresh: true });
  const token = session.tokens?.idToken?.toString();
  if (!token) throw new Error('No ID token');
  return token;
}
