const $ = (id) => document.getElementById(id);
const id = location.pathname.split("/").pop();
const api = `/api/admin/sessions/${id}`;
let resultsOpen = false;
let qrLoaded = false;

const STAGE_TEXT = {
  waiting: ["Category shown", "Attendees see the category name. Nominees are hidden."],
  voting: ["Voting open", "Attendees see the nominees and can vote."],
  closed: ["Voting closed", "Attendees see that voting is closed. Nominees are hidden again."],
  finished: ["Finished", "Attendees see a thank-you message."],
};

function render(state) {
  document.title = state.name;
  $("name").textContent = state.name;
  const [label, text] = STAGE_TEXT[state.stage];
  $("stage").textContent = label;
  $("stage-text").textContent = text;

  const finished = state.stage === "finished";
  $("category").textContent = finished ? "All categories done" : state.category;
  $("progress").textContent = finished
    ? `${state.total} categories`
    : `Category ${state.position} of ${state.total} · ${state.voteCount} votes`;

  $("start").disabled = !(state.stage === "waiting" || state.stage === "closed") || state.nominees.length === 0;
  $("stop").disabled = state.stage !== "voting";
  $("next").disabled = !(state.stage === "waiting" || state.stage === "closed");
  $("next").textContent = state.position === state.total ? "Finish session" : "Next category";
  $("add-form").hidden = finished;

  $("nominees").replaceChildren(
    ...state.nominees.map((nominee) => {
      const li = document.createElement("li");
      li.textContent = nominee.name;
      return li;
    }),
  );

  if (!qrLoaded) {
    qrLoaded = true;
    $("qr").src = `${api}/qr`;
    $("qr-large").src = `${api}/qr`;
    $("url").href = state.attendeeUrl;
    $("url").textContent = state.attendeeUrl;
    $("qr-caption").textContent = state.attendeeUrl;
  }
}

async function renderResults() {
  if (!resultsOpen) return;
  const res = await fetch(`${api}/results`);
  if (!res.ok) return;
  const { categories } = await res.json();
  $("results").replaceChildren(
    ...categories.map((category) => {
      const section = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = category.name;
      const list = document.createElement("ul");
      list.className = "plain";
      for (const nominee of category.nominees) {
        const li = document.createElement("li");
        li.className = "result";
        const name = document.createElement("span");
        name.textContent = nominee.name;
        const votes = document.createElement("strong");
        votes.textContent = nominee.votes;
        li.append(name, votes);
        list.append(li);
      }
      section.append(title, list);
      return section;
    }),
  );
}

async function refresh() {
  const res = await fetch(api);
  if (res.status === 401) {
    location.href = "/admin";
    return;
  }
  if (!res.ok) {
    $("load-error").textContent = (await res.json()).error;
    return;
  }
  $("load-error").textContent = "";
  render(await res.json());
  await renderResults();
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
  await renderResults();
  return res.ok;
}

$("start").addEventListener("click", () => act("start"));
$("stop").addEventListener("click", () => act("stop"));
$("next").addEventListener("click", () => {
  if (confirm("Move on? Attendees can't vote in this category again.")) act("next");
});
$("add-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (await act("nominees", { name: $("nominee-name").value })) $("nominee-name").value = "";
});
$("results-toggle").addEventListener("click", async () => {
  resultsOpen = !resultsOpen;
  $("results").hidden = !resultsOpen;
  $("results-toggle").textContent = resultsOpen ? "Hide results" : "Show results";
  await renderResults();
});
$("qr-open").addEventListener("click", () => { $("qr-full").hidden = false; });
$("qr-full").addEventListener("click", () => { $("qr-full").hidden = true; });

refresh();
setInterval(refresh, 3000);
