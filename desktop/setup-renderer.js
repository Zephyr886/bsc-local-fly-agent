const start = document.querySelector("#start");
const skip = document.querySelector("#skip");
const status = document.querySelector("#status");
const bar = document.querySelector("#progress-bar");
const log = document.querySelector("#log");

function append(message) {
  const lines = `${log.textContent}${log.textContent ? "\n" : ""}${message}`.split("\n").slice(-120);
  log.textContent = lines.join("\n");
  log.scrollTop = log.scrollHeight;
}

window.flapDesktop.onProgress((event) => {
  status.textContent = event.message;
  append(event.message);
  log.classList.add("visible");
  if (typeof event.percent === "number") {
    bar.classList.remove("indeterminate");
    bar.style.width = `${event.percent}%`;
  } else {
    bar.style.width = "32%";
    bar.classList.add("indeterminate");
  }
  if (event.stage === "error") {
    start.disabled = false;
    skip.disabled = false;
    start.textContent = "重试安装";
    bar.classList.remove("indeterminate");
    bar.style.width = "0";
  }
});

start.addEventListener("click", async () => {
  start.disabled = true;
  skip.disabled = true;
  start.textContent = "正在安装…";
  const result = await window.flapDesktop.startSetup();
  if (result?.error) append(`错误：${result.error}`);
});

skip.addEventListener("click", async () => {
  start.disabled = true;
  skip.disabled = true;
  await window.flapDesktop.skipSetup();
});
