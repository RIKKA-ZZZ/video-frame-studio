"use strict";

const $ = (id) => document.getElementById(id);
const video = $("video");
const stage = $("stage");
const fileInput = $("file");
const scrubber = $("scrubber");
const entry = $("time-entry");
const filmstrip = $("filmstrip");
const exportButton = $("export");
const formatNotes = {
  png: "无损图片，保留画面细节。",
  jpg: "通用格式，可调节画质和文件大小。",
  webp: "体积较小，适合在网页中使用。"
};
const mimeTypes = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };
const thumbnailCount = 8;
const demo = { url: "assets/demo.mp4", name: "云海航拍.mp4", size: 4614251, initialTime: 4.2 };
const mediaControls = ["play", "prev", "next", "mute", "time-entry", "time-go", "scrubber"].map($);

let source;
let sourceController;
let ready = false;
let exportInProgress = false;
let noticeTimer;
let dragDepth = 0;
let editingTime = false;

function formatTime(seconds, showMillis = true) {
  const ms = Math.round(Math.max(0, seconds) * 1000);
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor(ms / 60000) % 60;
  const wholeSeconds = Math.floor(ms / 1000) % 60;
  const pad = (number) => String(number).padStart(2, "0");
  const stamp = (hours ? pad(hours) + ":" : "") + pad(minutes) + ":" + pad(wholeSeconds);
  return showMillis ? stamp + "." + String(ms % 1000).padStart(3, "0") : stamp;
}

function parseTime(value) {
  const parts = value.trim().replace(/[：]/g, ":").split(":");
  if (parts.length > 3) return NaN;
  if (parts.some((part, i) => !(i === parts.length - 1 ? /^\d+(?:\.\d+)?$/ : /^\d+$/).test(part))) return NaN;
  if (parts.slice(1).some((part) => Number(part) >= 60)) return NaN;
  return parts.reduce((seconds, part) => seconds * 60 + Number(part), 0);
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(1) + " MB";
  return (bytes / 1024 ** 3).toFixed(2) + " GB";
}

function showNotice(message, error = false) {
  const notice = $("notice");
  clearTimeout(noticeTimer);
  notice.toggleAttribute("data-error", error);
  notice.querySelector("span").textContent = message;
  notice.hidden = false;
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 5200);
}

function showVideoMessage(title, body, showDemo) {
  $("message-title").textContent = title;
  $("message-body").textContent = body;
  $("restore-demo").hidden = !showDemo;
  $("video-message").hidden = false;
}

function syncControls() {
  for (const button of mediaControls) button.disabled = !ready;
  exportButton.disabled = !ready || exportInProgress || video.seeking || video.readyState < 2;
  exportButton.querySelector("span").textContent = exportInProgress ? "正在生成图片…" : "导出当前帧";
  const playLabel = video.paused ? "播放" : "暂停";
  $("play").setAttribute("aria-label", playLabel);
  $("play").querySelector("use").setAttribute("href", video.paused ? "#i-play" : "#i-pause");
  const muteLabel = video.muted ? "取消静音" : "静音";
  $("mute").setAttribute("aria-label", muteLabel);
  $("mute").title = muteLabel;
  $("mute").querySelector("use").setAttribute("href", video.muted ? "#i-muted" : "#i-volume");
}

function syncTime(seconds = ready ? video.currentTime : 0) {
  const duration = ready ? video.duration : 0;
  const ratio = duration ? Math.min(1, Math.max(0, seconds / duration)) : 0;
  const stamp = formatTime(seconds);
  $("play-time").textContent = stamp;
  $("selected-time").textContent = stamp;
  if (!editingTime) entry.value = stamp;
  scrubber.value = String(seconds);
  scrubber.setAttribute("aria-valuetext", stamp);
  $("timeline-inner").style.setProperty("--progress", (ratio * 100) + "%");
  const activeThumbnail = Math.min(Math.floor(ratio * thumbnailCount), thumbnailCount - 1);
  for (const [index, thumbnail] of Array.from(filmstrip.children).entries()) {
    thumbnail.classList.toggle("is-current", ready && index === activeThumbnail);
  }
}

function makeFilmstrip(duration = 0) {
  Array.from($("ruler").children).forEach((label, index, labels) => {
    label.textContent = formatTime(duration * index / (labels.length - 1), duration > 0 && duration < 4);
  });
  const thumbnails = Array.from({ length: thumbnailCount }, () => {
    const img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    return img;
  });
  filmstrip.replaceChildren(...thumbnails);
  return thumbnails;
}

function waitForMedia(media, isReady, events, signal) {
  signal.throwIfAborted();
  if (media.error) return Promise.reject(media.error);
  if (isReady()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Media timed out")), 12000);
    function finish(error) {
      clearTimeout(timer);
      events.forEach((event) => media.removeEventListener(event, check));
      media.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    }
    function check() { if (isReady()) finish(); }
    function onError() { finish(media.error || new Error("Media failed")); }
    function onAbort() { finish(signal.reason); }
    events.forEach((event) => media.addEventListener(event, check));
    media.addEventListener("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function canDraw(media) {
  return media.readyState >= 2 && !media.seeking;
}

async function fillThumbnails(url, thumbnails, signal) {
  const sampler = document.createElement("video");
  sampler.preload = "auto";
  sampler.muted = true;
  sampler.playsInline = true;
  sampler.src = url;
  const canvas = document.createElement("canvas");
  canvas.width = 204;
  canvas.height = 116;
  const context = canvas.getContext("2d", { alpha: false });
  try {
    await waitForMedia(sampler, () => canDraw(sampler), ["loadeddata", "canplay"], signal);
    const scale = Math.max(canvas.width / sampler.videoWidth, canvas.height / sampler.videoHeight);
    const width = sampler.videoWidth * scale;
    const height = sampler.videoHeight * scale;
    for (const [index, target] of thumbnails.entries()) {
      signal.throwIfAborted();
      sampler.currentTime = (index + 0.5) * sampler.duration / thumbnails.length;
      await waitForMedia(sampler, () => canDraw(sampler), ["seeked", "canplay"], signal);
      context.drawImage(sampler, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
      target.src = canvas.toDataURL("image/jpeg", 0.75);
    }
  } catch {
    // Preview and export still work if thumbnail sampling is unavailable.
  } finally {
    sampler.removeAttribute("src");
    sampler.load();
  }
}

function showMediaError() {
  ready = false;
  stage.setAttribute("aria-busy", "false");
  showVideoMessage("无法读取此视频", "请尝试浏览器支持的视频，例如 H.264 编码的 MP4。", true);
  syncControls();
  syncTime(0);
}

function syncResolution() {
  if (ready) $("resolution").textContent = video.videoWidth + " × " + video.videoHeight;
}

function clampTime(seconds) {
  return Math.min(Math.max(0, video.duration - 0.001), Math.max(0, seconds));
}

async function loadSource(next) {
  sourceController?.abort();
  const previous = source;
  const controller = new AbortController();
  sourceController = controller;
  source = next;
  const usingDemo = next === demo;

  ready = false;
  video.pause();
  video.muted = false;
  $("notice").hidden = true;
  editingTime = false;
  entry.setCustomValidity("");
  $("duration").textContent = "00:00.000";
  $("resolution").textContent = "—";
  $("clip-length").textContent = "—";
  $("file-name").textContent = next.name;
  $("file-name").title = next.name;
  $("file-subtitle").textContent = usingDemo ? "示例视频" : "本地文件";
  $("source-tag").lastChild.textContent = usingDemo ? " 示例视频" : " 本地视频";
  $("clip-size").textContent = formatSize(next.size);
  stage.setAttribute("aria-busy", "true");
  makeFilmstrip();
  syncTime(0);
  syncControls();

  if (usingDemo) {
    video.poster = "assets/demo-poster.jpg";
    $("video-message").hidden = true;
  } else {
    video.removeAttribute("poster");
    showVideoMessage("正在读取视频…", next.name, false);
  }

  video.src = next.url;
  video.load();
  if (previous?.local) URL.revokeObjectURL(previous.url);

  try {
    await waitForMedia(video, () => video.readyState >= 1, ["loadedmetadata"], controller.signal);
    if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight) {
      throw new Error("This file has no seekable video track");
    }
    if (next.initialTime) video.currentTime = clampTime(next.initialTime);
    await waitForMedia(video, () => canDraw(video), ["loadeddata", "seeked", "canplay"], controller.signal);
    controller.signal.throwIfAborted();
    ready = true;
    stage.setAttribute("aria-busy", "false");
    $("video-message").hidden = true;
    scrubber.max = String(Math.max(0, video.duration - 0.001));
    $("duration").textContent = formatTime(video.duration);
    $("clip-length").textContent = formatTime(video.duration);
    syncResolution();
    syncTime();
    syncControls();
    const thumbnails = makeFilmstrip(video.duration);
    syncTime();
    if (usingDemo) {
      thumbnails.forEach((thumbnail, i) => { thumbnail.src = "assets/thumb-" + (i + 1) + ".jpg"; });
    } else {
      void fillThumbnails(next.url, thumbnails, controller.signal);
    }
  } catch {
    if (!controller.signal.aborted) showMediaError();
  }
}

function selectFile(file) {
  if (!file) return;
  void loadSource({ url: URL.createObjectURL(file), name: file.name, size: file.size, local: true });
}

function seek(seconds) {
  if (!ready || !Number.isFinite(seconds)) return;
  video.pause();
  video.currentTime = clampTime(seconds);
  syncTime();
  syncControls();
}

async function togglePlayback() {
  if (!ready) return;
  if (!video.paused) {
    video.pause();
    return;
  }
  try {
    await video.play();
  } catch (error) {
    if (error.name !== "AbortError") showNotice("视频暂时无法播放。", true);
  }
}

function selectedFormat() {
  return document.querySelector('input[name="format"]:checked').value;
}

async function exportFrame() {
  if (!ready || exportInProgress) return;
  const signal = sourceController.signal;
  const name = source.name;
  const format = selectedFormat();
  const quality = Number($("quality").value) / 100;
  exportInProgress = true;
  video.pause();
  syncControls();
  const canvas = document.createElement("canvas");
  try {
    await waitForMedia(video, () => canDraw(video), ["seeked", "loadeddata", "canplay"], signal);
    signal.throwIfAborted();
    const time = formatTime(video.currentTime).replace(/:/g, "-");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    const mime = mimeTypes[format];
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
    signal.throwIfAborted();
    if (!blob || blob.type !== mime) throw new Error("Cannot encode the requested image format");
    const url = URL.createObjectURL(blob);
    const fileBase = name.replace(/\.[^.]+$/, "").replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").slice(0, 100) || "video";
    const link = document.createElement("a");
    link.href = url;
    link.download = fileBase + "-frame-" + time + "." + format;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    showNotice("图片已生成 · " + format.toUpperCase() + " · " + formatSize(blob.size));
  } catch {
    if (!signal.aborted) showNotice("图片导出失败，请重试或切换为 PNG。", true);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    exportInProgress = false;
    syncControls();
  }
}

$("open-video").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  selectFile(fileInput.files[0]);
  fileInput.value = "";
});
$("restore-demo").addEventListener("click", () => void loadSource(demo));
$("play").addEventListener("click", togglePlayback);
video.addEventListener("click", togglePlayback);
$("prev").addEventListener("click", () => seek(video.currentTime - 0.1));
$("next").addEventListener("click", () => seek(video.currentTime + 0.1));
$("mute").addEventListener("click", () => { video.muted = !video.muted; });
scrubber.addEventListener("input", () => seek(scrubber.valueAsNumber));
$("export").addEventListener("click", exportFrame);
for (const event of ["play", "pause", "ended", "volumechange", "seeking", "seeked", "waiting", "canplay"]) {
  video.addEventListener(event, syncControls);
}
for (const event of ["timeupdate", "seeked"]) video.addEventListener(event, () => syncTime());
video.addEventListener("resize", syncResolution);
video.addEventListener("error", () => { if (ready) showMediaError(); });

for (const option of document.querySelectorAll('input[name="format"]')) {
  option.addEventListener("change", () => {
    const format = selectedFormat();
    $("format-note").textContent = formatNotes[format];
    $("quality-row").hidden = format === "png";
  });
}
$("quality").addEventListener("input", (event) => {
  $("quality-value").value = event.target.value + "%";
});

const timeForm = $("time-form");
entry.addEventListener("input", () => {
  editingTime = true;
  entry.setCustomValidity("");
});
entry.addEventListener("focus", () => { editingTime = true; entry.select(); });
timeForm.addEventListener("focusout", (event) => {
  if (timeForm.contains(event.relatedTarget)) return;
  editingTime = false;
  entry.setCustomValidity("");
  syncTime();
});
timeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const seconds = parseTime(entry.value);
  if (!Number.isFinite(seconds) || seconds > video.duration + 0.0005) {
    entry.setCustomValidity("请在视频时长内输入秒数，或使用 00:04.250 这样的时间格式。");
    entry.reportValidity();
    return;
  }
  editingTime = false;
  seek(seconds);
  entry.blur();
  syncTime();
});

document.addEventListener("keydown", (event) => {
  if (!ready || event.altKey || event.ctrlKey || event.metaKey) return;
  const editing = event.target !== scrubber && event.target.closest("button, input, a, [contenteditable]");
  if (editing) return;
  if (event.code === "Space" && event.target !== scrubber) {
    event.preventDefault();
    if (!event.repeat) void togglePlayback();
  }
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    seek(video.currentTime + (event.key === "ArrowLeft" ? -0.1 : 0.1));
  }
});

function isFileDrag(event) {
  return event.dataTransfer.types.includes("Files");
}
stage.addEventListener("dragenter", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dragDepth += 1;
  stage.classList.add("dragging");
});
stage.addEventListener("dragleave", (event) => {
  if (!isFileDrag(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) stage.classList.remove("dragging");
});
document.addEventListener("dragover", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = stage.contains(event.target) ? "copy" : "none";
});
document.addEventListener("drop", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dragDepth = 0;
  stage.classList.remove("dragging");
  if (stage.contains(event.target)) selectFile(event.dataTransfer.files[0]);
});

void loadSource(demo);
