const demoEvents = [
  { id: 1, time: "16:18", displayTime: "4:18 PM", title: "Person entered restricted zone", type: "alert", typeLabel: "Security alert", camera: "Backyard", description: "A person was detected inside the configured backyard zone.", duration: "01:23", status: "Needs review", statusClass: "review", icon: "!", scene: "scene-back", tag: "CAM 03", date: "2026-10-13" },
  { id: 2, time: "16:05", displayTime: "4:05 PM", title: "Person left the property", type: "arrival", typeLabel: "Departure", camera: "Front entrance", description: "A tracked person was detected moving out through the main entrance.", duration: "00:52", status: "Logged", statusClass: "logged", icon: "↗", scene: "scene-entry", tag: "CAM 01", date: "2026-10-13" },
  { id: 3, time: "15:42", displayTime: "3:42 PM", title: "Person arrived home", type: "arrival", typeLabel: "Arrival", camera: "Driveway", description: "A person was detected entering the driveway area.", duration: "00:48", status: "Logged", statusClass: "logged", icon: "⌂", scene: "scene-drive", tag: "CAM 02", date: "2026-10-13" },
  { id: 4, time: "14:14", displayTime: "2:14 PM", title: "Delivery person detected", type: "delivery", typeLabel: "Delivery", camera: "Front entrance", description: "A person approached the front door carrying a parcel. This label is illustrative and is not currently inferred by the model.", duration: "01:24", status: "Logged", statusClass: "logged", icon: "▣", scene: "scene-entry", tag: "CAM 01", date: "2026-10-13" },
  { id: 5, time: "13:26", displayTime: "1:26 PM", title: "Person detected near entrance", type: "person", typeLabel: "Person detected", camera: "Front entrance", description: "A person was visible in the entrance camera view.", duration: "00:37", status: "Logged", statusClass: "info", icon: "♙", scene: "scene-entry", tag: "CAM 01", date: "2026-10-13" },
  { id: 6, time: "11:52", displayTime: "11:52 AM", title: "Movement detected in living room", type: "person", typeLabel: "Person detected", camera: "Living room", description: "Movement was recorded in the living room camera area.", duration: "00:29", status: "Logged", statusClass: "info", icon: "♙", scene: "scene-hall", tag: "CAM 04", date: "2026-10-13" },
  { id: 7, time: "09:11", displayTime: "9:11 AM", title: "Person left through main entrance", type: "arrival", typeLabel: "Departure", camera: "Front entrance", description: "A person was detected leaving through the front entrance.", duration: "00:41", status: "Logged", statusClass: "logged", icon: "↗", scene: "scene-entry", tag: "CAM 01", date: "2026-10-13" },
  { id: 8, time: "08:03", displayTime: "8:03 AM", title: "Person detected in driveway", type: "person", typeLabel: "Person detected", camera: "Driveway", description: "A person was detected in the driveway view.", duration: "00:32", status: "Logged", statusClass: "info", icon: "♙", scene: "scene-drive", tag: "CAM 02", date: "2026-10-13" }
];

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const pages = ["overview", "cameras", "events", "recordings"];
let toastTimer;

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function navigate(page) {
  if (!pages.includes(page)) return;
  $$(".page-view").forEach(view => view.classList.toggle("active", view.id === `page-${page}`));
  $$(".nav-link").forEach(link => link.classList.toggle("active", link.dataset.page === page));
  $("#mobileMenu").setAttribute("aria-expanded", "false");
  $(".main-nav").classList.remove("mobile-open");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.addEventListener("click", event => {
  const nav = event.target.closest("[data-page]");
  if (nav) {
    event.preventDefault();
    navigate(nav.dataset.page);
  }
});

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const light = theme === "light";
  $("#themeToggle").setAttribute("aria-label", light ? "Switch to dark mode" : "Switch to light mode");
  $("#themeIcon").textContent = light ? "☾" : "☼";
  document.querySelector('meta[name="theme-color"]').content = light ? "#f4f6f8" : "#11151d";
  try { localStorage.setItem("sentinel-theme", theme); } catch (_) {}
}
$("#themeToggle").addEventListener("click", () => {
  setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
});
try {
  const savedTheme = localStorage.getItem("sentinel-theme");
  if (savedTheme === "light" || savedTheme === "dark") setTheme(savedTheme);
} catch (_) {}

$("#mobileMenu").addEventListener("click", () => {
  const nav = $(".main-nav");
  const open = nav.classList.toggle("mobile-open");
  $("#mobileMenu").setAttribute("aria-expanded", String(open));
});

function sceneMarkup(scene, tag) {
  let detail = "";
  if (scene === "scene-entry") detail = '<div class="scene-door"></div><div class="scene-person"></div><div class="detection-box"></div>';
  if (scene === "scene-drive") detail = '<div class="drive-ground"></div><div class="drive-car"></div><div class="drive-tree"></div>';
  if (scene === "scene-back") detail = '<div class="back-fence"></div><div class="back-person"></div>';
  if (scene === "scene-hall") detail = '<div class="hall-window"></div><div class="hall-sofa"></div><div class="hall-lamp"></div>';
  return `<div class="${scene}">${detail}<span class="event-thumb-tag">${tag}</span></div>`;
}

function renderMiniEvents() {
  $("#overviewEvents").innerHTML = demoEvents.slice(0, 4).map(event => `
    <div class="mini-event" data-event-id="${event.id}" tabindex="0" role="button" aria-label="View ${event.title}">
      <div class="event-symbol ${event.type}">${event.icon}</div>
      <div><div class="mini-event-title">${event.title}</div><div class="mini-event-sub">${event.camera} · ${event.typeLabel}</div></div>
      <div class="event-time">${event.displayTime}</div>
    </div>`).join("");
}

function renderEventList() {
  const query = $("#eventSearch").value.trim().toLowerCase();
  const type = $("#eventTypeFilter").value;
  const camera = $("#eventCameraFilter").value;
  const date = $("#eventDateFilter").value;
  const filtered = demoEvents.filter(event => {
    const matchesQuery = !query || [event.title, event.camera, event.description, event.typeLabel].some(value => value.toLowerCase().includes(query));
    const matchesType = type === "all" || event.type === type;
    const matchesCamera = camera === "all" || event.camera === camera;
    const matchesDate = !date || event.date === date;
    return matchesQuery && matchesType && matchesCamera && matchesDate;
  });
  $("#eventList").innerHTML = filtered.map(event => `
    <article class="event-row ${event.statusClass === "review" ? "important" : ""}" data-event-id="${event.id}" tabindex="0" role="button" aria-label="Open event: ${event.title}">
      <div class="event-row-time">${event.displayTime}</div><div class="timeline-node"></div>
      <div class="event-card">
        <div class="event-thumb ${event.scene}">${sceneMarkup(event.scene, event.tag)}</div>
        <div class="event-card-content">
          <div class="event-type-label">${event.typeLabel}</div>
          <div class="event-title">${event.title}</div>
          <div class="event-description">${event.description}</div>
          <div class="event-metadata"><span>▣ ${event.camera}</span><span>▷ ${event.duration}</span></div>
        </div>
        <span class="event-status ${event.statusClass}">${event.status}</span>
      </div>
    </article>`).join("");
  $("#emptyEvents").classList.toggle("hidden", filtered.length > 0);
  $("#eventList").classList.toggle("hidden", filtered.length === 0);
  $("#eventCount").textContent = filtered.length;
}

function openEvent(eventId) {
  const event = demoEvents.find(item => item.id === Number(eventId));
  if (!event) return;
  $("#modalPreview").className = `modal-preview ${event.scene}`;
  $("#modalPreview").innerHTML = `${sceneMarkup(event.scene, event.tag)}<span class="modal-camera-tag">${event.tag}</span><span class="modal-play">▷</span>`;
  $("#modalTitle").textContent = event.title;
  $("#modalDescription").textContent = event.description;
  $("#modalCamera").textContent = event.camera;
  $("#modalTimestamp").textContent = `${event.date} · ${event.displayTime}`;
  $("#modalType").textContent = event.typeLabel;
  $("#modalDuration").textContent = event.duration;
  $("#eventModal").classList.remove("hidden");
  $("#closeModal").focus();
}
function closeEventModal() { $("#eventModal").classList.add("hidden"); }
document.addEventListener("click", event => {
  const item = event.target.closest("[data-event-id]");
  if (item) openEvent(item.dataset.eventId);
});
document.addEventListener("keydown", event => {
  const item = event.target.closest("[data-event-id]");
  if (item && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    openEvent(item.dataset.eventId);
  }
  if (event.key === "Escape") closeEventModal();
});
$("#closeModal").addEventListener("click", closeEventModal);
$("#eventModal").addEventListener("click", event => {
  if (event.target === $("#eventModal")) closeEventModal();
});

["eventSearch", "eventTypeFilter", "eventCameraFilter", "eventDateFilter"].forEach(id => {
  $(`#${id}`).addEventListener(id === "eventSearch" ? "input" : "change", renderEventList);
});
$("#clearFilters").addEventListener("click", () => {
  $("#eventSearch").value = "";
  $("#eventTypeFilter").value = "all";
  $("#eventCameraFilter").value = "all";
  $("#eventDateFilter").value = "";
  renderEventList();
});
$("#cameraFilter").addEventListener("change", event => {
  const value = event.target.value;
  $$("#allCameras > .camera-card").forEach(card => {
    card.classList.toggle("hidden", value !== "all" && card.dataset.status !== value);
  });
});
$("#recordingCameraFilter").addEventListener("change", event => {
  const value = event.target.value;
  $$(".recording-card").forEach(card => card.classList.toggle("hidden", value !== "all" && card.dataset.camera !== value));
});

$("#exportEvents").addEventListener("click", () => {
  const headers = ["timestamp", "event", "type", "camera", "description", "status"];
  const rows = demoEvents.map(event => [event.date + " " + event.displayTime, event.title, event.typeLabel, event.camera, event.description, event.status]);
  const csv = [headers, ...rows].map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = "sentinel-demo-events.csv"; link.click();
  URL.revokeObjectURL(url);
  showToast("Demo event history exported as CSV.");
});

$("#uploadButton").addEventListener("click", () => $("#videoUpload").click());
let activeVideoUrl = null;
$("#videoUpload").addEventListener("change", event => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  if (activeVideoUrl) URL.revokeObjectURL(activeVideoUrl);
  activeVideoUrl = URL.createObjectURL(file);
  $("#previewVideo").src = activeVideoUrl;
  $("#uploadedPreview").classList.remove("hidden");
  $("#uploadedPreview").scrollIntoView({ behavior: "smooth", block: "start" });
  showToast(`Local preview ready: ${file.name}`);
});
$("#closePreview").addEventListener("click", () => {
  $("#previewVideo").pause();
  $("#previewVideo").removeAttribute("src");
  $("#previewVideo").load();
  $("#uploadedPreview").classList.add("hidden");
  if (activeVideoUrl) URL.revokeObjectURL(activeVideoUrl);
  activeVideoUrl = null;
  $("#videoUpload").value = "";
});
$$("[data-demo='camera']").forEach(button => button.addEventListener("click", () => showToast("Camera feed is sample UI. Live streaming will be added with backend integration.")));
$$(".recording-open").forEach(button => button.addEventListener("click", () => {
  const key = button.dataset.sample;
  const event = key === "delivery" ? demoEvents[3] : key === "arrival" ? demoEvents[2] : demoEvents[0];
  openEvent(event.id);
}));
renderMiniEvents();
renderEventList();
