const button = document.querySelector("#open");
const status = document.querySelector("#status");
button.addEventListener("click", async () => {
  button.disabled = true;
  status.textContent = "Opening your study window…";
  try {
    const result = await chrome.runtime.sendMessage({ type: "mateit-open-study-window" });
    if (!result?.ok) throw new Error(result?.error || "Could not open the study window.");
    status.textContent = "Study window opened.";
    window.close();
  } catch (error) {
    status.textContent = error?.message || "Could not open the study window.";
    button.disabled = false;
  }
});
