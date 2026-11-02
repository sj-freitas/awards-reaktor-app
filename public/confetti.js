const CONFETTI = ["🎉", "🎊", "🏆", "⭐", "✨", "🥳", "🌟"];

function burstConfetti(layer, count) {
  for (let i = 0; i < count; i++) {
    const piece = document.createElement("span");
    piece.className = "confetti";
    piece.textContent = CONFETTI[Math.floor(Math.random() * CONFETTI.length)];
    piece.style.fontSize = `${2 + Math.random() * 4}vh`;
    layer.append(piece);

    const angle = Math.random() * Math.PI * 2;
    const reach = 20 + Math.random() * 70;
    const x = Math.cos(angle) * reach;
    const y = Math.sin(angle) * reach * 0.7;
    const spin = (Math.random() - 0.5) * 1080;
    const flight = piece.animate(
      [
        { transform: "translate(-50%, -50%) scale(.3)", opacity: 1 },
        { transform: `translate(calc(-50% + ${x}vw), calc(-50% + ${y}vh)) rotate(${spin / 2}deg)`, opacity: 1, offset: 0.3, easing: "ease-in" },
        { transform: `translate(calc(-50% + ${x * 1.25}vw), calc(-50% + ${y + 130}vh)) rotate(${spin}deg)`, opacity: 0.9 },
      ],
      { duration: 2800 + Math.random() * 2200, easing: "cubic-bezier(.1, .7, .3, 1)", fill: "forwards" },
    );
    flight.onfinish = () => piece.remove();
  }
}

function launchConfetti() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const layer = document.getElementById("confetti");
  burstConfetti(layer, 90);
  setTimeout(() => burstConfetti(layer, 60), 500);
  setTimeout(() => burstConfetti(layer, 60), 1100);
}
