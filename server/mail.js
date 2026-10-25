// Outgoing email via Resend's HTTP API (https://resend.com). Configure with RESEND_API_KEY and
// MAIL_FROM (an address on a domain verified in Resend, e.g. noreply@grid-alert.com).
// Without a key, emails are written to the server log instead so nothing is lost while
// setting up (the admin area also shows set-password links when an email could not be sent).
const API = "https://api.resend.com/emails";

const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Plain, robust HTML that renders in every mail client.
function layout({ heading, paragraphs = [], button, footer }) {
  const ps = paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.5;color:#33434d">${p}</p>`).join("");
  const btn = button
    ? `<p style="margin:22px 0"><a href="${escapeHtml(button.url)}" style="display:inline-block;padding:11px 20px;border-radius:8px;background:#0f8f6c;color:#ffffff;font-weight:600;text-decoration:none">${escapeHtml(button.label)}</a></p>
       <p style="margin:0 0 14px;font-size:12px;color:#5d6f7a">Or paste this link into your browser:<br><span style="word-break:break-all">${escapeHtml(button.url)}</span></p>`
    : "";
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px">
    <p style="margin:0 0 18px;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#0f8f6c">Grid Alert Victoria</p>
    <h1 style="margin:0 0 16px;font-size:20px;color:#13202a">${escapeHtml(heading)}</h1>
    ${ps}${btn}
    <p style="margin:24px 0 0;font-size:12px;color:#5d6f7a">${footer ?? "You received this because of activity on grid-alert.com."}</p>
  </div>`;
}

export async function sendMail({ to, subject, heading, paragraphs, button, footer, replyTo }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || "Grid Alert Victoria <noreply@grid-alert.com>";
  const html = layout({ heading: heading ?? subject, paragraphs, button, footer });
  if (!key) {
    console.log(`MAIL (not sent — RESEND_API_KEY not set) to=${to} subject="${subject}"${button ? ` link=${button.url}` : ""}`);
    return false;
  }
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return true;
  } catch (error) {
    console.error(`MAIL failed to=${to} subject="${subject}": ${error.message}${button ? ` link=${button.url}` : ""}`);
    return false;
  }
}

export { escapeHtml };
