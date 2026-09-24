import {
  listFlightPhotos,
  uploadFlightPhoto,
  deleteFlightPhoto,
  signPhotoUrl,
  MAX_PHOTOS_PER_FLIGHT,
  MAX_INPUT_BYTES,
  MAX_UPLOAD_BYTES,
} from "./photos.js";
import { shrinkImage } from "./image.js";

// ---- Full-size viewer -----------------------------------------------------
// A single instance appended to <body>, not inside any flight card: cards
// clip their contents (`.flight-card { overflow: hidden }`), so an in-card
// overlay would be cropped.

let viewer = null;

function ensureViewer() {
  if (viewer) return viewer;

  const root = document.createElement("div");
  root.className = "photo-viewer";
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Photo");
  root.innerHTML = `
    <button type="button" class="photo-viewer-close" aria-label="Close photo">
      <span aria-hidden="true">&times;</span>
    </button>
    <img class="photo-viewer-img" alt="" />
  `;
  document.body.appendChild(root);

  // The photo fills most of a phone screen, so tapping the photo itself (not
  // just the backdrop) closing the viewer is what people expect.
  root.addEventListener("click", () => closeViewer());

  viewer = {
    root,
    img: root.querySelector(".photo-viewer-img"),
    closeBtn: root.querySelector(".photo-viewer-close"),
    lastFocus: null,
  };
  return viewer;
}

function onViewerKeydown(event) {
  if (event.key === "Escape") closeViewer();
}

export async function openViewer(photo, label) {
  const v = ensureViewer();
  v.lastFocus = document.activeElement;
  v.img.removeAttribute("src");
  v.img.alt = label || "Flight photo";
  v.root.hidden = false;

  const app = document.querySelector(".app");
  if (app) app.inert = true;
  document.addEventListener("keydown", onViewerKeydown);
  v.closeBtn.focus();

  // Re-sign on every open rather than trusting the list's URL — a card left
  // expanded past the signed-URL TTL should never show a dead image.
  try {
    v.img.src = await signPhotoUrl(photo.path);
  } catch {
    v.img.alt = "This photo couldn't be loaded.";
  }
}

export function closeViewer() {
  if (!viewer || viewer.root.hidden) return;
  viewer.root.hidden = true;
  viewer.img.removeAttribute("src");
  const app = document.querySelector(".app");
  if (app) app.inert = false;
  document.removeEventListener("keydown", onViewerKeydown);
  viewer.lastFocus?.focus?.();
  viewer.lastFocus = null;
}

// ---- Per-flight photo section ----------------------------------------------

function markBroken(tile, openBtn) {
  tile.classList.add("is-broken");
  openBtn.disabled = true;
  openBtn.innerHTML = '<span aria-hidden="true">⚠</span>';
}

export function mountFlightPhotos(slotEl, flight) {
  const flightId = flight.id;
  let photos = [];

  slotEl.innerHTML = `
    <section class="photos" aria-label="Photos">
      <div class="photos-head">
        <h3 class="photos-title">Photos</h3>
        <label class="photo-add">
          <span>Add photos</span>
          <input class="photo-input visually-hidden" type="file" accept="image/*" multiple />
        </label>
      </div>
      <p class="photos-status" role="status" aria-live="polite" hidden></p>
      <div class="photo-grid"></div>
      <p class="photos-empty" hidden>No photos yet</p>
    </section>
  `;

  const grid = slotEl.querySelector(".photo-grid");
  const emptyEl = slotEl.querySelector(".photos-empty");
  const statusEl = slotEl.querySelector(".photos-status");
  const addLabel = slotEl.querySelector(".photo-add");
  const input = slotEl.querySelector(".photo-input");

  function setStatus(message, type = "") {
    if (!message) {
      statusEl.hidden = true;
      statusEl.textContent = "";
      statusEl.className = "photos-status";
      return;
    }
    statusEl.hidden = false;
    statusEl.textContent = message;
    statusEl.className = `photos-status ${type}`.trim();
  }

  function updateAddState() {
    const atCap = photos.length >= MAX_PHOTOS_PER_FLIGHT;
    addLabel.classList.toggle("is-disabled", atCap);
    input.disabled = atCap;
  }

  function renderSkeletons(count) {
    grid.replaceChildren();
    for (let i = 0; i < count; i++) {
      const tile = document.createElement("div");
      tile.className = "photo-tile is-loading";
      grid.appendChild(tile);
    }
  }

  function photoTile(photo, index) {
    const tile = document.createElement("div");
    tile.className = "photo-tile";

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "photo-open";
    openBtn.setAttribute("aria-label", `View photo ${index + 1} of ${photos.length}`);

    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = "";

    let retried = false;
    img.addEventListener("error", async () => {
      if (retried) {
        markBroken(tile, openBtn);
        return;
      }
      retried = true;
      try {
        const fresh = await signPhotoUrl(photo.path);
        photo.url = fresh;
        img.src = fresh;
      } catch {
        markBroken(tile, openBtn);
      }
    });

    if (photo.url) {
      img.src = photo.url;
      openBtn.appendChild(img);
    } else {
      markBroken(tile, openBtn);
    }

    openBtn.addEventListener("click", () => openViewer(photo, `Photo ${index + 1}`));

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "photo-del";
    delBtn.setAttribute("aria-label", `Delete photo ${index + 1} of ${photos.length}`);
    delBtn.innerHTML = '<span aria-hidden="true">&times;</span>';
    delBtn.addEventListener("click", async (event) => {
      event.stopPropagation();
      delBtn.disabled = true;
      try {
        await deleteFlightPhoto(photo.path);
        photos = photos.filter((p) => p.path !== photo.path);
        renderGrid();
      } catch (error) {
        delBtn.disabled = false;
        setStatus(error.message || "Couldn't delete that photo.", "error");
      }
    });

    tile.appendChild(openBtn);
    tile.appendChild(delBtn);
    return tile;
  }

  function renderGrid() {
    grid.replaceChildren();
    emptyEl.hidden = photos.length > 0;
    photos.forEach((photo, index) => grid.appendChild(photoTile(photo, index)));
    updateAddState();
  }

  async function load() {
    renderSkeletons(3);
    try {
      photos = await listFlightPhotos(flightId);
      renderGrid();
    } catch (error) {
      grid.replaceChildren();
      emptyEl.hidden = true;
      setStatus(error.message || "Couldn't load photos.", "error");
    }
  }

  async function handleFiles(fileList) {
    let files = Array.from(fileList);
    if (files.length === 0) return;

    const capRemaining = MAX_PHOTOS_PER_FLIGHT - photos.length;
    const truncated = files.length > capRemaining;
    files = files.slice(0, Math.max(0, capRemaining));
    if (files.length === 0) {
      setStatus(`Limit ${MAX_PHOTOS_PER_FLIGHT} photos per flight.`, "error");
      return;
    }

    input.disabled = true;
    addLabel.classList.add("is-disabled");

    // Sequential, not parallel: decoding several full-size phone photos at
    // once is what actually exhausts memory on a phone, and it gives an
    // honest "n of total" status instead of a percentage we can't compute
    // (supabase-js v2 has no upload-progress callback).
    let succeeded = 0;
    const failures = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setStatus(`Uploading ${i + 1} of ${files.length}…`);

      if (file.size > MAX_INPUT_BYTES) {
        failures.push(`${file.name} is too large (max 25 MB).`);
        continue;
      }

      let blob;
      try {
        blob = await shrinkImage(file);
        if (blob.size > MAX_UPLOAD_BYTES) {
          blob = await shrinkImage(file, { maxEdge: 1200, quality: 0.7 });
        }
        if (blob.size > MAX_UPLOAD_BYTES) {
          failures.push(`${file.name} is too large even after compression.`);
          continue;
        }
      } catch (error) {
        failures.push(error.message || `Couldn't process ${file.name}.`);
        continue;
      }

      try {
        await uploadFlightPhoto(flightId, blob);
        succeeded += 1;
      } catch (error) {
        failures.push(error.message || `Couldn't upload ${file.name}.`);
      }
    }

    try {
      photos = await listFlightPhotos(flightId);
    } catch {
      // Leave the previously rendered grid as-is; it'll catch up next time
      // the card is reopened.
    }
    renderGrid();

    if (failures.length === 0) {
      setStatus(truncated ? `Added ${succeeded} photos. Limit ${MAX_PHOTOS_PER_FLIGHT} per flight reached.` : "");
    } else {
      const summary = succeeded > 0 ? `${succeeded} of ${files.length} photos added. ` : "";
      setStatus(`${summary}${failures.length} failed: ${failures[0]}`, "error");
    }

    input.value = "";
  }

  input.addEventListener("change", () => handleFiles(input.files));

  load();
}
