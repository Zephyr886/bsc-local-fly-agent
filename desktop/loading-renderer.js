const status = document.querySelector("#startup-status");
const detail = document.querySelector("#startup-detail");

window.flapDesktop.onProgress((event) => {
  status.textContent = event.message;
  const labels = {
    preflight: "只读预检：磁盘空间、旧数据、SQLite 与活动 checkpoint",
    migration: "迁移使用可恢复 journal；原始文件保持不变",
    "migration-complete": "迁移完成，正在启动本地后端",
    error: "请查看错误对话框中的桌面日志位置",
  };
  detail.textContent = labels[event.stage] || "正在准备本地运行环境";
});
