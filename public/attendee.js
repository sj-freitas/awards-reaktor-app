const $ = (id) => document.getElementById(id);
const code = location.pathname.split("/").pop();
const MESSAGES = {
  lobby: "Keep this page open. The first category will appear here.",
  waiting: "Voting isn't open yet. The nominees are being revealed.",
  voting: "Tap a nominee to vote. You can change your vote until voting closes.",
  closed: "Voting for this category is closed.",
};
let tiles = new Map();
let tilesCategory;
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

// One tile per nominee, kept across polls and stages so a picture never reloads or flashes.
function tileFor(nominee) {
  let tile = tiles.get(nominee.name);
  if (!tile) {
    tile = document.createElement("button");
    const name = document.createElement("span");
    name.textContent = nominee.name;
    tile.append(nomineePicture(nominee), name);
    tile.addEventListener("click", () => vote(tile.dataset.id));
    tiles.set(nominee.name, tile);
  }
  return tile;
}

function render(state) {
  if (state.category !== tilesCategory) {
    tilesCategory = state.category;
    tiles = new Map();
  }
  document.title = state.name;
  $("session").textContent = state.name;
  $("title").textContent =
    state.stage === "finished" ? "Thanks for voting!" : state.stage === "lobby" ? "We'll start soon" : state.category;
  $("message").textContent = MESSAGES[state.stage] ?? "";

  const locked = (state.revealed ?? []).map((nominee) => {
    const tile = tileFor(nominee);
    tile.className = "nominee revealed";
    tile.disabled = true;
    tile.removeAttribute("aria-pressed");
    return tile;
  });
  const open = (state.nominees ?? []).map((nominee) => {
    const tile = tileFor(nominee);
    const selected = nominee.id === state.myVote;
    tile.className = selected ? "nominee selected" : "nominee";
    tile.disabled = false;
    tile.dataset.id = nominee.id;
    tile.setAttribute("aria-pressed", String(selected));
    return tile;
  });
  const shown = [...locked, ...open];
  const list = $("nominees");
  // Leaves tiles already in place alone and only adds what's new.
  [...list.children].forEach((tile) => {
    if (!shown.includes(tile)) tile.remove();
  });
  shown.forEach((tile, index) => {
    if (list.children[index] !== tile) list.insertBefore(tile, list.children[index] ?? null);
  });
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
