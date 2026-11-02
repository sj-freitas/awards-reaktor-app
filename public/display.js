const id = location.pathname.split("/").pop();
const api = `/api/admin/sessions/${id}/display`;
const STATUS = { waiting: "Meet the nominees", voting: "Voting is open", closed: "Voting is closed" };
let currentSlide = "";
let grid = null;
let gridTotal = 0;
let shownNominees = new Set();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showSlide(...children) {
  const slide = element("div", "slide");
  const brand = element("div", "slide-brand");
  brand.append(element("strong", "", "Reaktor"), element("span", "status", ""));
  slide.append(brand, ...children);
  document.getElementById("slide").replaceChildren(slide);
  return brand.querySelector(".status");
}

// Pictures keep one size whatever the nominee count, and the grid rearranges around them. The space
// is worked out for the whole category up front, so nothing moves as each nominee is revealed.
// They only shrink if the nominees can't otherwise fit on this screen.
const PICTURE_HEIGHT_VH = 28;
const PICTURE_RATIO = 0.8;
const NAME_HEIGHT_VH = 5;
const GAP_VH = 2.5;

function layoutGrid() {
  if (!grid || !grid.isConnected) return;
  const vh = window.innerHeight / 100;
  const total = Math.max(gridTotal, 1);
  let height = PICTURE_HEIGHT_VH * vh;
  let maxColumns;
  let rows;
  for (; ; height -= vh) {
    maxColumns = Math.max(Math.floor((grid.clientWidth + GAP_VH * vh) / (height * PICTURE_RATIO + GAP_VH * vh)), 1);
    rows = Math.ceil(total / maxColumns);
    const needed = rows * (height + NAME_HEIGHT_VH * vh) + (rows - 1) * GAP_VH * vh;
    if (needed <= grid.clientHeight || height <= 10 * vh) break;
  }
  grid.style.gridTemplateColumns = `repeat(${Math.ceil(total / rows)}, ${height * PICTURE_RATIO}px)`;
  grid.style.gridTemplateRows = `repeat(${rows}, ${height + NAME_HEIGHT_VH * vh}px)`;
}

function renderNominees(state) {
  const key = `nominees:${state.category}`;
  if (key !== currentSlide) {
    currentSlide = key;
    shownNominees = new Set();
    const head = element("div", "slide-head");
    head.append(element("h1", "", state.category));
    grid = element("div", "slide-grid");
    showSlide(head, grid);
  }
  document.querySelector(".status").textContent = STATUS[state.stage];
  grid.classList.toggle("closed", state.stage === "closed");
  gridTotal = state.totalNominees;
  layoutGrid();
  // Only adds what's new, so revealed nominees animate once and pictures don't reload.
  for (const nominee of state.nominees) {
    if (shownNominees.has(nominee.id)) continue;
    shownNominees.add(nominee.id);
    const card = element("div", "slide-card");
    card.append(nomineePicture(nominee), element("div", "card-name", nominee.name));
    grid.append(card);
  }
}

function renderWinners(state) {
  const key = `winner:${state.category}`;
  if (key === currentSlide) return;
  currentSlide = key;
  const head = element("div", "slide-head");
  head.append(element("h1", "", state.category));
  const winners = element("div", state.winners.length > 1 ? "slide-winners tied" : "slide-winners");
  for (const winner of state.winners) {
    const card = element("div", "slide-winner");
    card.append(nomineePicture(winner), element("p", "display", winner.name));
    winners.append(card);
  }
  const status = showSlide(head, winners);
  status.textContent = state.winners.length > 1 ? "It's a tie: shared award" : "The winner is";
}

function renderCentered(key, build) {
  if (key === currentSlide) return;
  currentSlide = key;
  const center = element("div", "slide-center");
  build(center);
  showSlide(center);
}

function render(state) {
  document.title = state.name;
  if (state.stage === "lobby") {
    renderCentered("lobby", (center) => {
      const qr = element("img", "qr");
      qr.src = `/api/s/${state.code}/qr`;
      qr.alt = "QR code that opens the voting page";
      center.append(element("p", "display", state.name), qr, element("p", "muted", state.attendeeUrl.replace(/^https?:\/\//, "")));
    });
  } else if (state.stage === "finished") {
    renderCentered("finished", (center) => center.append(element("p", "display", "Thank you!")));
  } else if (state.stage === "winner") {
    renderWinners(state);
  } else {
    renderNominees(state);
  }
}

async function refresh() {
  let res;
  try {
    res = await fetch(api);
  } catch {
    return; // Keep the current slide up and try again on the next poll.
  }
  if (res.status === 401 || res.status === 403) {
    location.href = `/admin?returnTo=${encodeURIComponent(location.pathname)}`;
    return;
  }
  if (res.ok) render(await res.json());
}

window.addEventListener("resize", layoutGrid);
refresh();
setInterval(refresh, 1500);
