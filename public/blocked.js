// Fills in the block page from its query string: ?url=...&reason=...&allowed=...
const q = new URLSearchParams(location.search);
document.getElementById("url").textContent = q.get("url") ?? "";
document.getElementById("reason").textContent = q.get("reason") ?? "not allowed";
document.getElementById("allowed").textContent = q.get("allowed") ?? "";
