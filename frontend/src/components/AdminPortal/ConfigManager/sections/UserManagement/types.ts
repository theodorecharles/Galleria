export interface User {
  id: number;
  email: string;
  name: string;
  role: string;
  is_active: boolean;
  mfa_enabled: boolean;
  passkey_count: number;
  auth_methods: string[];
  status?: string;
  picture?: string;
  // invite_token is no longer returned by GET /api/auth-extended/users —
  // admins fetch it on demand via GET /api/auth-extended/users/:userId/invite-link.
}

export interface Passkey {
  id: string;
  name: string;
  created_at: string;
}

export interface MFASetupData {
  userId: number;
  qrCode: string;
  secret: string;
  backupCodes: string[];
  setupToken: string;
}

export interface NewUserState {
  email: string;
  role: string;
  inviteToken?: string;
}

export interface PasswordChangeState {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export interface MessageType {
  type: "success" | "error";
  text: string;
}

