const $ = (id) => document.getElementById(id);
const code = location.pathname.split("/").pop();
const MESSAGES = {
  waiting: "Nominees will appear here when voting starts.",
  voting: "Tap a nominee to vote. You can change your vote until voting closes.",
  closed: "Voting for this category is closed.",
};

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

function render(state) {
  document.title = state.name;
  $("session").textContent = state.stage === "finished" ? state.name : `${state.name} · Category ${state.position} of ${state.total}`;
  $("title").textContent = state.stage === "finished" ? "Thanks for voting!" : state.category;
  $("message").textContent = MESSAGES[state.stage] ?? "";
  $("nominees").replaceChildren(
    ...(state.nominees ?? []).map((nominee) => {
      const button = document.createElement("button");
      button.className = nominee.id === state.myVote ? "nominee selected" : "nominee";
      button.setAttribute("aria-pressed", String(nominee.id === state.myVote));
      button.textContent = nominee.name;
      button.addEventListener("click", () => vote(nominee.id));
      return button;
    }),
  );
}

async function refresh() {
  try {
    const res = await fetch(`/api/s/${code}`);
    const body = await res.json();
    if (!res.ok) {
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

refresh();
setInterval(refresh, 2000);
