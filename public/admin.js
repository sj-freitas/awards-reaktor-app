const $ = (id) => document.getElementById(id);

async function loadSessions() {
  const res = await fetch("/api/admin/sessions");
  const sessions = await res.json();
  const list = $("sessions");
  list.replaceChildren();
  if (sessions.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "No sessions yet.";
    list.append(li);
  }
  for (const session of sessions) {
    const li = document.createElement("li");
    li.className = "row spread";
    const link = document.createElement("a");
    link.href = `/admin/sessions/${session.id}`;
    link.textContent = session.name;
    const stage = document.createElement("span");
    stage.className = "stage";
    stage.textContent = session.stage;
    li.append(link, stage);
    list.append(li);
  }
}

function updatePreview() {
  const text = $("json").value.trim();
  $("preview").textContent = "";
  if (!text) return;
  try {
    const { categories, allowedEmails } = JSON.parse(text);
    const nominees = categories.reduce((sum, c) => sum + (c.nominees?.length ?? 0), 0);
    $("preview").textContent = `${categories.length} categories, ${nominees} nominees, ${allowedEmails?.length ?? 0} allowed attendees`;
  } catch {
    $("preview").textContent = "This isn't valid JSON yet.";
  }
}

async function init() {
  const me = await fetch("/api/admin/me");
  if (!me.ok) {
    $("signin").hidden = false;
    const params = new URLSearchParams(location.search);
    const returnTo = params.get("returnTo");
    if (returnTo) $("signin-link").href = `/auth/google?returnTo=${encodeURIComponent(returnTo)}`;
    if (me.status === 403) $("signin-error").textContent = `${(await me.json()).email} isn't an admin. Sign in with another account.`;
    if (params.get("error") === "signin") $("signin-error").textContent = "Sign-in failed. Please try again.";
    return;
  }
  $("app").hidden = false;
  $("me").textContent = (await me.json()).email;
  await loadSessions();
}

$("file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  $("json").value = await file.text();
  updatePreview();
});
$("json").addEventListener("input", updatePreview);

$("logout").addEventListener("click", async () => {
  await fetch("/auth/logout", { method: "POST" });
  location.href = "/admin";
});

$("create").addEventListener("click", async () => {
  $("create-error").textContent = "";
  let ballot;
  try {
    ballot = JSON.parse($("json").value);
  } catch {
    $("create-error").textContent = "The categories JSON isn't valid.";
    return;
  }
  const res = await fetch("/api/admin/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: $("name").value, ballot }),
  });
  const body = await res.json();
  if (!res.ok) {
    $("create-error").textContent = body.error;
    return;
  }
  location.href = `/admin/sessions/${body.id}`;
});

init();
