const $ = (id) => document.getElementById(id);
const code = location.pathname.split("/").pop();
const MESSAGES = {
  lobby: "Keep this page open. The first category will appear here.",
  waiting: "Voting isn't open yet. The nominees are being revealed.",
  voting: "Tap a nominee to vote. You can change your vote until voting closes.",
  closed: "Voting for this category is closed.",
};
let lastRendered = "";
let poll;

async function vote(nomineeId) {
  $("error").textContent = "";
  const res = await fetch(`/api/s/${code}/vote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nomineeId }),
  });
  if (!res.ok) $("error").textContent = (await res.json()).error;
  await refresh();
}

function nomineeContent(element, nominee) {
  const name = document.createElement("span");
  name.textContent = nominee.name;
  element.append(nomineePicture(nominee), name);
  return element;
}

function render(state) {
  // Polling mostly returns the same thing. Rebuilding anyway would make the pictures flicker.
  const signature = JSON.stringify(state);
  if (signature === lastRendered) return;
  lastRendered = signature;

  document.title = state.name;
  $("session").textContent = state.name;
  $("title").textContent =
    state.stage === "finished" ? "Thanks for voting!" : state.stage === "lobby" ? "We'll start soon" : state.category;
  $("message").textContent = MESSAGES[state.stage] ?? "";
  $("nominees").replaceChildren(
    ...(state.revealed ?? []).map((nominee) => {
      const item = document.createElement("div");
      item.className = "nominee revealed";
      item.setAttribute("aria-disabled", "true");
      return nomineeContent(item, nominee);
    }),
    ...(state.nominees ?? []).map((nominee) => {
      const button = document.createElement("button");
      button.className = nominee.id === state.myVote ? "nominee selected" : "nominee";
      button.setAttribute("aria-pressed", String(nominee.id === state.myVote));
      button.addEventListener("click", () => vote(nominee.id));
      return nomineeContent(button, nominee);
    }),
  );
}

function showSignIn(title, message, label) {
  clearInterval(poll);
  $("title").textContent = title;
  $("message").textContent = message;
  $("signin").textContent = label;
  $("signin").href = `/auth/google?returnTo=${encodeURIComponent(location.pathname)}`;
  $("signin").hidden = false;
}

async function refresh() {
  try {
    const res = await fetch(`/api/s/${code}`);
    const body = await res.json();
    if (res.status === 401) {
      const failed = new URLSearchParams(location.search).get("error") === "signin";
      showSignIn("Sign in to vote", failed ? "Sign-in failed. Please try again." : "Use the Google account you were invited with.", "Sign in with Google");
      return;
    }
    if (res.status === 403) {
      showSignIn("You're not on the list", `${body.email} can't vote in this session. Try another account, or ask the organizer to check the list.`, "Use another account");
      return;
    }
    if (!res.ok) {
      clearInterval(poll);
      $("title").textContent = body.error;
      return;
    }
    render(body);
  } catch {
    $("error").textContent = "Connection lost. Retrying…";
    return;
  }
  if ($("error").textContent.startsWith("Connection lost")) $("error").textContent = "";
}

poll = setInterval(refresh, 2000);
refresh();
