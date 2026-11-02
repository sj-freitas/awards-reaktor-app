// A nominee's picture, falling back to their initials when there's none or it fails to load.
function nomineePicture(nominee) {
  const box = document.createElement("div");
  box.className = "picture";
  const showInitials = () => {
    box.textContent = nominee.name
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0])
      .join("")
      .toUpperCase();
  };
  if (!nominee.pictureUrl) {
    showInitials();
    return box;
  }
  const image = document.createElement("img");
  image.src = nominee.pictureUrl;
  image.alt = "";
  image.referrerPolicy = "no-referrer";
  image.addEventListener("error", showInitials);
  box.append(image);
  return box;
}
