// Canvas-based downscaling, deliberately dependency-free: this module loads on
// a page with no Supabase bundle present, which is what makes it testable on
// its own.

export const MAX_EDGE = 1600;
export const QUALITY = 0.82;

// Well under the canvas area ceiling mobile Safari enforces.
const MAX_SOURCE_PIXELS = 40e6;

export async function shrinkImage(file, { maxEdge = MAX_EDGE, quality = QUALITY } = {}) {
  const source = await decode(file);
  const sourceWidth = source.width || source.naturalWidth;
  const sourceHeight = source.height || source.naturalHeight;
  if (!sourceWidth || !sourceHeight) throw new Error("That image looks empty or corrupt.");
  if (sourceWidth * sourceHeight > MAX_SOURCE_PIXELS) {
    throw new Error("That image is too large to process on this device.");
  }

  const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(source, 0, 0, width, height);
  if (typeof source.close === "function") source.close();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  // Releases the backing store immediately rather than waiting on GC, which
  // matters when several 12MP photos are processed back to back on a phone.
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) throw new Error("Couldn't process that photo.");

  // Re-encoding an already-small JPEG can make it bigger. Keep the original.
  if (scale === 1 && file.type === "image/jpeg" && blob.size >= file.size) return file;
  return blob;
}

async function decode(file) {
  if (typeof createImageBitmap === "function") {
    try {
      // Returns the bitmap already EXIF-rotated, so width/height are display
      // dimensions and drawImage comes out upright.
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // Safari 15–16.3 rejects the options bag outright. The <img> path below
      // is an equivalent result, not a downgrade: current engines default
      // <img> to image-orientation: from-image.
    }
  }
  return decodeViaImg(file);
}

function decodeViaImg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(unsupportedMessage(file)));
    };
    img.src = url;
  });
}

// Phrased from the filename, but only reached once decoding has actually
// failed — iOS often hands over a transcoded JPEG that is still named .heic,
// and rejecting those up front would refuse photos we can read fine.
function unsupportedMessage(file) {
  const name = file.name || "";
  const type = file.type || "";
  if (/\.(heic|heif)$/i.test(name) || /heic|heif/i.test(type)) {
    return "This browser can't read HEIC photos. On iPhone: Settings → Camera → Formats → Most Compatible, or share the photo to convert it to JPEG first.";
  }
  return "That file isn't an image this browser can read.";
}
