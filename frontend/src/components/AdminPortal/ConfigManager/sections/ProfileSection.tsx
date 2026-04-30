/**
 * Profile Section Component
 * Allows non-admin users (viewers/managers) to manage their own account
 */

import React, { useState, useEffect } from "react";
import { useTranslation } from 'react-i18next';
import { API_URL } from '../../../../config';
import { MFASetupModal } from "./UserManagement/MFASetupModal";
import { ConfirmationModal } from "./UserManagement/ConfirmationModal";
import { UserCard } from "./UserManagement/UserCard";
import { PasskeysModal } from "./UserManagement/PasskeysModal";
import { PasswordChangeModal } from "./UserManagement/PasswordChangeModal";
import { userManagementAPI } from "./UserManagement/utils";
import type {
  User,
  Passkey,
  MFASetupData,
  PasswordChangeState,
  MessageType,
} from "./UserManagement/types";
import { error as logError, info } from '../../../../utils/logger';


interface ProfileSectionProps {
  setMessage: (message: MessageType) => void;
}

export const ProfileSection: React.FC<ProfileSectionProps> = ({
  setMessage,
}) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [showPasswordChange, setShowPasswordChange] = useState<
    number | undefined
  >(undefined);
  const [passwordChange, setPasswordChange] = useState<PasswordChangeState>({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [showPasskeys, setShowPasskeys] = useState<number | undefined>(
    undefined
  );
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [passkeyName, setPasskeyName] = useState("");
  const [mfaSetup, setMfaSetup] = useState<MFASetupData | null>(null);
  const [mfaToken, setMfaToken] = useState("");
  const [confirmModal, setConfirmModal] = useState({
    show: false,
    title: "",
    message: "",
    confirmText: "",
    isDangerous: false,
    requirePassword: false,
    onConfirm: (_password?: string) => {},
  });
  const [confirmPassword, setConfirmPassword] = useState("");

  useEffect(() => {
    loadCurrentUser();
  }, []);

  const loadCurrentUser = async () => {
    try {
      const user = await userManagementAPI.fetchCurrentUser();
      if (user) {
        // Fetch full user details
        const res = await fetch(`${API_URL}/api/auth/status`, {
          credentials: "include",
        });
        if (res.ok) {
          const data = await res.json();
          info('[ProfileSection] Auth status data:', data);
          if (data.authenticated && data.user) {
            info('[ProfileSection] Setting user with passkey_count:', data.user.passkey_count);
            setCurrentUser({
              id: data.user.id,
              email: data.user.email,
              name: data.user.name,
              picture: data.user.picture,
              role: data.user.role,
              mfa_enabled: data.user.mfa_enabled,
              passkey_count: data.user.passkey_count || 0,
              auth_methods: data.user.auth_methods || [],
              is_active: true,
              status: "active",
            });
          }
        }
      }
    } catch (err) {
      logError("Failed to load current user:", err);
    }
  };

  const handleStartMFASetup = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/auth-extended/mfa/setup`, {
        method: 'POST',
        credentials: "include",
      });

      if (!res.ok) throw new Error(t('profile.failedToStartMfaSetup'));

      const data = await res.json();
      setMfaSetup(data);
      setMfaToken("");
    } catch (err: any) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  };

  const handleCompleteMFASetup = async (): Promise<void> => {
    if (!mfaSetup) return;

    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/auth-extended/mfa/verify-setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          setupToken: mfaSetup.setupToken,
          token: mfaToken,
          backupCodes: mfaSetup.backupCodes,
        }),
      });

      if (!res.ok) throw new Error(t('profile.failedToVerifyMfaSetup'));

      setMessage({ type: "success", text: t('userManagement.mfaEnabledSuccessfully') });
      setMfaSetup(null);
      setMfaToken("");
      await loadCurrentUser();
    } catch (err: any) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  };

  const handleDisableMFA = async (): Promise<void> => {
    setConfirmModal({
      show: true,
      title: t('profile.disableMfa'),
      message: t('userManagement.disableMfaConfirm'),
      confirmText: t('userManagement.disableMfa'),
      isDangerous: true,
      requirePassword: true,
      onConfirm: (password) => {
        if (!password) return;
        setConfirmModal({ ...confirmModal, show: false });
        setConfirmPassword("");
        performDisableMFA(password);
      },
    });
  };

  const performDisableMFA = async (password: string): Promise<void> => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/auth-extended/mfa/disable`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password }),
      });

      if (!res.ok) throw new Error(t('profile.failedToDisableMfa'));

      setMessage({ type: "success", text: t('userManagement.mfaDisabledSuccessfully') });
      await loadCurrentUser();
    } catch (err: any) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  };

  const handleLoadPasskeys = async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/auth-extended/passkey/list`, {
        credentials: "include",
      });

      if (!res.ok) throw new Error(t('userManagement.failedToLoadPasskeys'));

      const data = await res.json();
      setPasskeys(data.passkeys || []);
      setShowPasskeys(currentUser?.id);
    } catch (err) {
      setMessage({ type: "error", text: t('userManagement.failedToLoadPasskeys') });
    } finally {
      setLoading(false);
    }
  };

  const handleRegisterPasskey = async (): Promise<void> => {
    if (!passkeyName.trim()) {
      setMessage({ type: "error", text: t('userManagement.passkeyNameRequired') });
      return;
    }

    setLoading(true);
    try {
      const optionsRes = await fetch(
        `${API_URL}/api/auth-extended/passkey/register-options`,
        {
          method: "POST",
          credentials: "include",
        }
      );

      if (!optionsRes.ok) throw new Error(t('userManagement.failedToGetRegistrationOptions'));

      const options = await optionsRes.json();

      // Start WebAuthn registration
      const { startRegistration } = await import("@simplewebauthn/browser");
      const credential = await startRegistration(options);

      const verifyRes = await fetch(
        `${API_URL}/api/auth-extended/passkey/register-verify`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            credential,
            name: passkeyName,
          }),
        }
      );

      if (!verifyRes.ok) throw new Error(t('userManagement.passkeyRegistrationFailed'));

      setMessage({ type: "success", text: t('userManagement.passkeyRegisteredSuccessfully') });
      setPasskeyName("");
      // Update passkey list in modal and user data for passkey count badge
      if (showPasskeys !== undefined) {
        await handleLoadPasskeys();
      }
      await loadCurrentUser();
    } catch (err: any) {
      if (err.name === "NotAllowedError") {
        setMessage({ type: "error", text: t('userManagement.passkeyRegistrationCancelled') });
      } else {
        setMessage({
          type: "error",
          text: err.message || t('userManagement.passkeyRegistrationFailed'),
        });
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRemovePasskey = async (passkeyId: string) => {
    setLoading(true);
    try {
      const res = await fetch(
        `${API_URL}/api/auth-extended/passkey/${passkeyId}`,
        {
          method: "DELETE",
          credentials: "include",
        }
      );

      if (!res.ok) throw new Error(t('userManagement.failedToRemovePasskey'));

      setMessage({ type: "success", text: t('userManagement.passkeyRemovedSuccessfully') });
      // Update passkey list in modal and user data for passkey count badge
      if (showPasskeys !== undefined) {
        await handleLoadPasskeys();
      }
      await loadCurrentUser();
    } catch (err) {
      setMessage({ type: "error", text: t('userManagement.failedToRemovePasskey') });
    } finally {
      setLoading(false);
    }
  };

  const handleChangePassword = async (): Promise<void> => {
    if (passwordChange.newPassword !== passwordChange.confirmPassword) {
      setMessage({ type: "error", text: t('userManagement.passwordsDoNotMatch') });
      return;
    }

    if (passwordChange.newPassword.length < 8) {
      setMessage({
        type: "error",
        text: t('userManagement.passwordMinLength'),
      });
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/auth-extended/change-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          currentPassword: passwordChange.currentPassword,
          newPassword: passwordChange.newPassword,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || t('userManagement.failedToChangePassword'));
      }

      setMessage({ type: "success", text: t('userManagement.passwordChangedSuccessfully') });
      setShowPasswordChange(undefined);
      setPasswordChange({
        currentPassword: "",
        newPassword: "",
        confirmPassword: "",
      });
    } catch (err: any) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  };

  if (!currentUser) {
    return (
      <div style={{ padding: "2rem", textAlign: "center", color: "#888" }}>
        {t('common.loading')}
      </div>
    );
  }

  return (
    <div style={{ padding: "1rem 0" }}>
      <UserCard
        user={currentUser}
        currentUser={{ id: currentUser.id, email: currentUser.email, role: currentUser.role }}
        loading={loading}
        isFirstUser={true}
        onResendInvite={() => {}}
        onDeleteUser={() => {}}
        onOpenPasswordChange={setShowPasswordChange}
        onStartMFASetup={handleStartMFASetup}
        onDisableMFA={handleDisableMFA}
        onOpenPasskeys={handleLoadPasskeys}
        onResetMFA={() => {}}
        onSendPasswordReset={() => {}}
        onUpdateRole={() => {}}
      />

      {/* MFA Setup Modal */}
      {mfaSetup && (
        <MFASetupModal
          mfaSetup={mfaSetup}
          mfaToken={mfaToken}
          loading={loading}
          onClose={() => {
            setMfaSetup(null);
            setMfaToken("");
          }}
          onTokenChange={setMfaToken}
          onComplete={handleCompleteMFASetup}
        />
      )}

      {/* Passkeys Modal */}
      {showPasskeys !== undefined && (
        <PasskeysModal
          passkeys={passkeys}
          passkeyName={passkeyName}
          loading={loading}
          onClose={() => setShowPasskeys(undefined)}
          onNameChange={setPasskeyName}
          onRegister={handleRegisterPasskey}
          onRemove={handleRemovePasskey}
        />
      )}

      {/* Password Change Modal */}
      {showPasswordChange !== undefined && (
        <PasswordChangeModal
          passwordChange={passwordChange}
          loading={loading}
          onClose={() => setShowPasswordChange(undefined)}
          onPasswordChangeUpdate={setPasswordChange}
          onChangePassword={handleChangePassword}
        />
      )}

      {/* Confirmation Modal */}
      <ConfirmationModal
        show={confirmModal.show}
        title={confirmModal.title}
        message={confirmModal.message}
        confirmText={confirmModal.confirmText}
        isDangerous={confirmModal.isDangerous}
        requirePassword={confirmModal.requirePassword}
        password={confirmPassword}
        onPasswordChange={setConfirmPassword}
        onConfirm={confirmModal.onConfirm}
        onClose={() => setConfirmModal({ ...confirmModal, show: false })}
      />
    </div>
  );
};
