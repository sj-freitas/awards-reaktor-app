const DEFAULT_PICTURE = "/default-nominee.png";

// A nominee's picture, falling back to the Reaktor logo when there's none or it fails to load.
function nomineePicture(nominee) {
  const box = document.createElement("div");
  box.className = "picture";
  const image = document.createElement("img");
  image.alt = "";
  image.referrerPolicy = "no-referrer";
  image.addEventListener("error", () => {
    if (!image.src.endsWith(DEFAULT_PICTURE)) image.src = DEFAULT_PICTURE;
  });
  image.src = nominee.pictureUrl || DEFAULT_PICTURE;
  box.append(image);
  return box;
}
