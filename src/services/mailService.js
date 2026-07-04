const nodemailer = require('nodemailer');
const env = require('../config/env');

let transporter;

function getTransporter() {
  if (!env.smtp.host) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.secure,
      auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined,
    });
  }
  return transporter;
}

async function sendMail({ to, subject, text, html }) {
  const client = getTransporter();
  if (!client) {
    console.warn(`[mail] SMTP is not configured; skipped ${subject} for ${to}`);
    return { skipped: true };
  }
  return client.sendMail({ from: env.smtp.from, to, subject, text, html });
}

async function sendPublicationConfirmation({ email, url, plan, expiresAt, referenceId }) {
  return sendMail({
    to: email,
    subject: 'وب‌سایت drop.cv شما منتشر شد',
    text: `Your ${plan} site is live at ${url}. Payment reference: ${referenceId}. Active until ${expiresAt}.`,
    html: `<p>وب‌سایت شما منتشر شد.</p><p><a href="https://${url}">${url}</a></p><p>کد پیگیری: ${referenceId}</p>`,
  });
}

async function sendExpirationNotice({ email, url }) {
  return sendMail({
    to: email,
    subject: 'اشتراک drop.cv شما منقضی شد',
    text: `Your drop.cv subscription for ${url} has expired. Your draft remains available after login.`,
  });
}

async function sendRenewalReminder({ email, url, expiresAt }) {
  return sendMail({
    to: email,
    subject: 'یادآوری تمدید اشتراک drop.cv',
    text: `Your drop.cv subscription for ${url} expires on ${expiresAt}. Log in to renew and keep it online.`,
  });
}

async function sendTrialEndingReminder({ email, url, expiresAt }) {
  return sendMail({
    to: email,
    subject: 'Trial ends tomorrow on drop.cv',
    text: `Your free drop.cv trial for ${url} ends on ${expiresAt}. You still have 3 days of grace if you need more time.`,
  });
}

module.exports = {
  sendMail,
  sendPublicationConfirmation,
  sendExpirationNotice,
  sendRenewalReminder,
  sendTrialEndingReminder,
};
