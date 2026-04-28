/**
 * Email Service
 * Handles sending emails for user invitations and password resets
 */

import nodemailer from "nodemailer";
import { getCurrentConfig } from "./config.js";
import { error, info } from "./utils/logger.js";
import { translateBackend, getGlobalLocale } from "./i18n-backend.js";

export interface EmailConfig {
  enabled: boolean;
  smtp: {
    host: string;
    port: number;
    secure: boolean; // true for 465, false for other ports
    auth: {
      user: string;
      pass: string;
    };
  };
  from: {
    name: string;
    address: string;
  };
}

/**
 * Translation helper function with variable interpolation
 * Replaces {{variable}} placeholders in translated strings.
 *
 * Pass an explicit `locale` to render in the recipient's language. When omitted,
 * falls back to the globally configured locale.
 */
function t(key: string, variables?: Record<string, any>, locale?: string): string {
  const effectiveLocale = locale ?? getGlobalLocale();
  let translated = translateBackend(key, effectiveLocale);

  // Interpolate variables
  if (variables) {
    Object.entries(variables).forEach(([varName, value]) => {
      translated = translated.replace(new RegExp(`{{${varName}}}`, 'g'), String(value));
    });
  }

  return translated;
}

/**
 * Get email configuration from config.json
 */
function getEmailConfig(): EmailConfig | null {
  const config = getCurrentConfig();
  return (config as any).email || null;
}

/**
 * Check if email service is enabled
 */
export function isEmailServiceEnabled(): boolean {
  const emailConfig = getEmailConfig();
  return emailConfig?.enabled === true;
}

/**
 * Generate invitation URL for manual sharing (when email is disabled)
 */
export function generateInvitationUrl(inviteToken: string): string {
  const config = getCurrentConfig();

  // Get frontend URL - use allowedOrigins[0] as it's the actual frontend URL
  let frontendUrl = "http://localhost:3000";
  if (
    config.backend?.allowedOrigins &&
    config.backend.allowedOrigins.length > 0
  ) {
    frontendUrl = config.backend.allowedOrigins[0];
  }

  return `${frontendUrl}/invite/${inviteToken}`;
}

/**
 * Create nodemailer transporter
 */
function createTransporter() {
  const emailConfig = getEmailConfig();

  if (!emailConfig || !emailConfig.enabled) {
    return null;
  }

  return nodemailer.createTransport({
    host: emailConfig.smtp.host,
    port: emailConfig.smtp.port,
    secure: emailConfig.smtp.secure,
    auth: {
      user: emailConfig.smtp.auth.user,
      pass: emailConfig.smtp.auth.pass,
    },
  });
}

/**
 * Send user invitation email
 */
export async function sendInvitationEmail(
  toEmail: string,
  inviteToken: string,
  inviterName: string,
  language: string = 'en'
): Promise<boolean> {
  const transporter = createTransporter();
  const emailConfig = getEmailConfig();

  if (!transporter || !emailConfig) {
    error("[Email] Email service not configured - cannot send invitation");
    return false;
  }

  const config = getCurrentConfig();
  const siteName = config.branding?.siteName || "Galleria";

  // Get frontend URL - use allowedOrigins[0] as it's the actual frontend URL
  let frontendUrl = "http://localhost:3000";
  if (
    config.backend?.allowedOrigins &&
    config.backend.allowedOrigins.length > 0
  ) {
    frontendUrl = config.backend.allowedOrigins[0];
  }

  const inviteUrl = `${frontendUrl}/invite/${inviteToken}`;

  // Get avatar URL
  const avatarPath = config.branding?.avatarPath || "/photos/avatar.png";
  const avatarUrl = `${frontendUrl}${avatarPath}`;

  // Render in the recipient's language (falls back to 'en' inside translateBackend)
  info(`[Email] Sending invitation email in language: ${language}`);
  const tr = (key: string, variables?: Record<string, any>) => t(key, variables, language);

  const mailOptions = {
    from: `"${emailConfig.from.name}" <${emailConfig.from.address}>`,
    to: toEmail,
    subject: tr('email.invitation.subject', { siteName }),
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${tr('email.invitation.title', { siteName })}</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
          }
          .container {
            background-color: #f9f9f9;
            border-radius: 8px;
            padding: 30px;
            margin: 20px 0;
          }
          .avatar {
            width: 80px;
            height: 80px;
            border-radius: 50%;
            object-fit: cover;
            margin-bottom: 20px;
          }
          .button {
            display: inline-block;
            background-color: #4ade80;
            color: white;
            text-decoration: none;
            padding: 12px 30px;
            border-radius: 6px;
            margin: 20px 0;
            font-weight: 600;
          }
          .footer {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #ddd;
            font-size: 0.9em;
            color: #666;
          }
          .code {
            background-color: #f0f0f0;
            padding: 10px;
            border-radius: 4px;
            font-family: monospace;
            word-break: break-all;
            margin: 10px 0;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <img src="${avatarUrl}" alt="${siteName}" class="avatar" />
          <h1>${tr('email.invitation.title', { siteName })}</h1>
          <p>${tr('email.invitation.greeting')}</p>
          <p>${tr('email.invitation.body', { inviterName, siteName })}</p>
          <p>${tr('email.invitation.instructions')}</p>
          <a href="${inviteUrl}" class="button">${tr('email.invitation.button')}</a>
          <p>${tr('email.invitation.orCopyLink')}</p>
          <div class="code">${inviteUrl}</div>
          <p><strong>${tr('email.invitation.expiry')}</strong></p>
          <div class="footer">
            <p>${tr('email.invitation.footerIgnore')}</p>
            <p>${tr('email.invitation.footerAutomatic')}</p>
          </div>
        </div>
      </body>
      </html>
    `,
    text: `
${tr('email.invitation.title', { siteName })}

${tr('email.invitation.body', { inviterName, siteName }).replace(/<\/?strong>/g, '')}

${tr('email.invitation.instructions')}
${inviteUrl}

${tr('email.invitation.expiry')}

${tr('email.invitation.footerIgnore')}
    `.trim(),
  };

  try {
    await transporter.sendMail(mailOptions);
    info(`[Email] Invitation sent to ${toEmail}`);
    return true;
  } catch (err) {
    error("[Email] Failed to send invitation:", err);
    return false;
  }
}

/**
 * Send password reset email
 */
export async function sendPasswordResetEmail(
  toEmail: string,
  resetToken: string,
  userName: string | null,
  language: string = 'en'
): Promise<boolean> {
  const transporter = createTransporter();
  const emailConfig = getEmailConfig();

  if (!transporter || !emailConfig) {
    error("[Email] Email service not configured - cannot send password reset");
    return false;
  }

  const config = getCurrentConfig();
  const siteName = config.branding?.siteName || "Galleria";

  // Get frontend URL - use allowedOrigins[0] as it's the actual frontend URL
  let frontendUrl = "http://localhost:3000";
  if (
    config.backend?.allowedOrigins &&
    config.backend.allowedOrigins.length > 0
  ) {
    frontendUrl = config.backend.allowedOrigins[0];
  }

  const resetUrl = `${frontendUrl}/reset-password/${resetToken}`;

  // Get avatar URL
  const avatarPath = config.branding?.avatarPath || "/photos/avatar.png";
  const avatarUrl = `${frontendUrl}${avatarPath}`;

  // Render in the recipient's language (falls back to 'en' inside translateBackend)
  info(`[Email] Sending password reset email in language: ${language}`);
  const tr = (key: string, variables?: Record<string, any>) => t(key, variables, language);

  const greeting = userName
    ? tr('email.passwordReset.greeting', { userName })
    : tr('email.passwordReset.greetingFallback');

  const mailOptions = {
    from: `"${emailConfig.from.name}" <${emailConfig.from.address}>`,
    to: toEmail,
    subject: tr('email.passwordReset.subject', { siteName }),
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${tr('email.passwordReset.title')} - ${siteName}</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
          }
          .container {
            background-color: #f9f9f9;
            border-radius: 8px;
            padding: 30px;
            margin: 20px 0;
          }
          .avatar {
            width: 80px;
            height: 80px;
            border-radius: 50%;
            object-fit: cover;
            margin-bottom: 20px;
          }
          .button {
            display: inline-block;
            background-color: #ef4444;
            color: white;
            text-decoration: none;
            padding: 12px 30px;
            border-radius: 6px;
            margin: 20px 0;
            font-weight: 600;
          }
          .footer {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #ddd;
            font-size: 0.9em;
            color: #666;
          }
          .code {
            background-color: #f0f0f0;
            padding: 10px;
            border-radius: 4px;
            font-family: monospace;
            word-break: break-all;
            margin: 10px 0;
          }
          .warning {
            background-color: #fef2f2;
            border-left: 4px solid #ef4444;
            padding: 12px;
            margin: 20px 0;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <img src="${avatarUrl}" alt="${siteName}" class="avatar" />
          <h1>${tr('email.passwordReset.title')}</h1>
          <p>${greeting}</p>
          <p>${tr('email.passwordReset.body', { siteName })}</p>
          <p>${tr('email.passwordReset.instructions')}</p>
          <a href="${resetUrl}" class="button">${tr('email.passwordReset.button')}</a>
          <p>${tr('email.passwordReset.orCopyLink')}</p>
          <div class="code">${resetUrl}</div>
          <div class="warning">
            <strong>${tr('email.passwordReset.warningTitle')}</strong>
            <ul>
              <li>${tr('email.passwordReset.warningExpiry')}</li>
              <li>${tr('email.passwordReset.warningIgnore')}</li>
              <li>${tr('email.passwordReset.warningNoChange')}</li>
            </ul>
          </div>
          <div class="footer">
            <p>${tr('email.passwordReset.footerAutomatic')}</p>
            <p>${tr('email.passwordReset.footerContact')}</p>
          </div>
        </div>
      </body>
      </html>
    `,
    text: `
${tr('email.passwordReset.subject', { siteName })}

${greeting}

${tr('email.passwordReset.body', { siteName }).replace(/<\/?strong>/g, '')}

${tr('email.passwordReset.instructions')}
${resetUrl}

${tr('email.passwordReset.warningTitle')}
- ${tr('email.passwordReset.warningExpiry')}
- ${tr('email.passwordReset.warningIgnore')}
- ${tr('email.passwordReset.warningNoChange')}

${tr('email.passwordReset.footerAutomatic')}
    `.trim(),
  };

  try {
    await transporter.sendMail(mailOptions);
    info(`[Email] Password reset sent to ${toEmail}`);
    return true;
  } catch (err) {
    error("[Email] Failed to send password reset:", err);
    return false;
  }
}

/**
 * Test email configuration
 */
export async function testEmailConfig(): Promise<{
  success: boolean;
  error?: string;
}> {
  const transporter = createTransporter();

  if (!transporter) {
    return { success: false, error: "Email service not configured" };
  }

  try {
    await transporter.verify();
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

/**
 * Send a test email to verify SMTP configuration
 */
export async function sendTestEmail(toEmail: string, language: string = 'en'): Promise<boolean> {
  const transporter = createTransporter();
  const emailConfig = getEmailConfig();

  if (!transporter || !emailConfig) {
    error("[Email] Email service not configured - cannot send test email");
    return false;
  }

  const config = getCurrentConfig();
  const siteName = config.branding?.siteName || "Galleria";

  // Render in the recipient's language (falls back to 'en' inside translateBackend)
  info(`[Email] Test email language: ${language}`);
  const tr = (key: string, variables?: Record<string, any>) => t(key, variables, language);

  const timestamp = new Date().toLocaleString();

  const mailOptions = {
    from: `"${emailConfig.from.name}" <${emailConfig.from.address}>`,
    to: toEmail,
    subject: tr('email.test.subject', { siteName }),
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Test Email</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
          }
          .container {
            background-color: #f9f9f9;
            border-radius: 8px;
            padding: 30px;
            margin: 20px 0;
          }
          .success {
            color: #22c55e;
            font-size: 3rem;
            margin-bottom: 20px;
          }
          .footer {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #ddd;
            font-size: 0.9em;
            color: #666;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="success">${tr('email.test.success')}</div>
          <h1>${tr('email.test.title')}</h1>
          <p>${tr('email.test.body1')}</p>
          <p>${tr('email.test.body2', { siteName })}</p>
          <div class="footer">
            <p>${tr('email.test.footerTimestamp', { timestamp })}</p>
            <p>${tr('email.test.footerIgnore')}</p>
          </div>
        </div>
      </body>
      </html>
    `,
    text: `
${tr('email.test.title')}

${tr('email.test.success')} ${tr('email.test.body1')}

${tr('email.test.body2', { siteName }).replace(/<\/?strong>/g, '')}

${tr('email.test.footerTimestamp', { timestamp })}
${tr('email.test.footerIgnore')}
    `.trim(),
  };

  try {
    await transporter.sendMail(mailOptions);
    info(`[Email] Test email sent to ${toEmail}`);
    return true;
  } catch (err) {
    error("[Email] Failed to send test email:", err);
    return false;
  }
}
