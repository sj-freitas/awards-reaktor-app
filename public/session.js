const $ = (id) => document.getElementById(id);
const id = location.pathname.split("/").pop();
const api = `/api/admin/sessions/${id}`;

const STAGE_TEXT = {
  waiting: ["Category shown", "They see the category name. Nominees are hidden."],
  voting: ["Voting open", "They see the nominees and can vote."],
  closed: ["Voting closed", "They see that voting is closed. Nominees are hidden again."],
  finished: ["Finished", "They see a thank-you message."],
};

function renderCurrentWinner(state) {
  const current = state.stage === "closed" ? state.winners.find((w) => w.position === state.position) : null;
  $("winner").hidden = !current;
  if (!current) return;
  const names = current.winners;
  $("winner-label").textContent = names.length > 1 ? "Winners" : "Winner";
  $("winner-names").replaceChildren(
    ...(names.length ? names : ["No votes"]).map((name) => {
      const line = document.createElement("span");
      line.className = "winner-name";
      line.textContent = name;
      return line;
    }),
  );
  $("winner-note").textContent = names.length > 1 ? "It's a tie, so they share the award." : "";
}

function renderWinners(state) {
  $("winners-section").hidden = state.winners.length === 0;
  $("winners").replaceChildren(
    ...state.winners.map((category) => {
      const li = document.createElement("li");
      li.className = "past-winner";
      const title = document.createElement("p");
      title.className = "eyebrow";
      title.textContent = category.category;
      const names = document.createElement("strong");
      names.textContent = category.winners.length ? category.winners.join(" & ") : "No votes";
      li.append(title, names);
      return li;
    }),
  );
}

function render(state) {
  document.title = state.name;
  $("session-name").textContent = state.name;
  const [label, text] = STAGE_TEXT[state.stage];
  $("stage").textContent = label;
  $("stage-text").textContent = text;

  const finished = state.stage === "finished";
  $("category").textContent = finished ? "All categories done" : state.category;
  $("progress").textContent = finished
    ? `${state.total} categories`
    : `Category ${state.position} of ${state.total} · ${state.voteCount} votes`;

  // Only the moves that make sense right now, so the right one is easy to hit on a phone.
  $("actions").hidden = finished;
  $("start").hidden = state.stage === "voting";
  $("start").disabled = state.nominees.length === 0;
  $("start").textContent = state.stage === "closed" ? "Reopen voting" : "Start voting";
  $("start").className = state.stage === "closed" ? "secondary" : "";
  $("stop").hidden = state.stage !== "voting";
  $("next").hidden = state.stage === "voting";
  $("next").className = state.stage === "closed" ? "" : "secondary";
  $("next").textContent = state.position === state.total ? "Finish session" : "Next category";
  // The primary action comes first.
  if (state.stage === "closed") $("actions").prepend($("next"));
  else $("actions").prepend($("start"));

  $("nominee-section").hidden = finished;
  $("nominees").replaceChildren(
    ...state.nominees.map((nominee) => {
      const li = document.createElement("li");
      li.textContent = nominee.name;
      return li;
    }),
  );

  $("qr-link").href = state.qrPageUrl;
  $("url").href = state.attendeeUrl;
  $("url").textContent = state.attendeeUrl.replace(/^https?:\/\//, "");

  renderCurrentWinner(state);
  renderWinners(state);
}

async function refresh() {
  const res = await fetch(api);
  if (res.status === 401) {
    location.href = `/admin?returnTo=${encodeURIComponent(location.pathname)}`;
    return;
  }
  if (!res.ok) {
    $("load-error").textContent = (await res.json()).error;
    return;
  }
  $("load-error").textContent = "";
  render(await res.json());
}

async function act(path, body) {
  $("action-error").textContent = "";
  const res = await fetch(`${api}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const payload = await res.json();
  if (!res.ok) $("action-error").textContent = payload.error;
  if (res.ok || payload.state) render(res.ok ? payload : payload.state);
  return res.ok;
}

$("start").addEventListener("click", () => act("start"));
$("stop").addEventListener("click", () => act("stop"));
$("next").addEventListener("click", () => act("next"));
$("add-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (await act("nominees", { name: $("nominee-name").value })) $("nominee-name").value = "";
});

refresh();
setInterval(refresh, 3000);
