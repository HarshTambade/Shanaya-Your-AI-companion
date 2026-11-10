// Copy installShanayaComputerBridge(mainWindow) into the generated Electron main
// process. Dependencies for that shell: screenshot-desktop, sharp, @nut-tree/nut-js.
const screenshotDesktop = require("screenshot-desktop");
const sharp = require("sharp");
const { randomUUID } = require("node:crypto");
const { mouse, keyboard, Button, Point, Key } = require("@nut-tree/nut-js");

const keyNames = {
  ENTER: "Enter", RETURN: "Enter", ESC: "Escape", ESCAPE: "Escape", TAB: "Tab",
  SPACE: "Space", BACKSPACE: "Backspace", DELETE: "Delete", HOME: "Home", END: "End",
  PAGEUP: "PageUp", PAGEDOWN: "PageDown", UP: "Up", DOWN: "Down", LEFT: "Left", RIGHT: "Right",
  CTRL: "LeftControl", CONTROL: "LeftControl", SHIFT: "LeftShift", ALT: "LeftAlt",
  CMD: "LeftSuper", META: "LeftSuper", SUPER: "LeftSuper",
};

function resolveKeys(text) {
  const chord = String(text || "").split("+").map((part) => part.trim().toUpperCase()).filter(Boolean);
  if (!chord.length || chord.length > 4) throw new Error("Invalid keyboard chord.");
  return chord.map((part) => {
    const keyName = keyNames[part] || part[0] + part.slice(1).toLowerCase();
    if (!(keyName in Key)) throw new Error(`Unsupported key: ${part}`);
    return Key[keyName];
  });
}

function resolveModifiers(text) {
  if (!text) return [];
  const aliases = { CTRL: "CTRL", CONTROL: "CTRL", SHIFT: "SHIFT", ALT: "ALT", SUPER: "SUPER", META: "META", CMD: "CMD", COMMAND: "CMD" };
  const modifiers = String(text).split("+").map((part) => part.trim().toUpperCase()).filter(Boolean);
  if (!modifiers.length || modifiers.length > 4 || modifiers.some((part) => !aliases[part])) {
    throw new Error("Unsupported mouse modifier key.");
  }
  return resolveKeys(modifiers.map((part) => aliases[part]).join("+"));
}

function installShanayaComputerBridge(mainWindow) {
  const { dialog, ipcMain } = require("electron");
  let lastImageSize = null;
  const approvals = new Map();
  const allowedActions = new Set(["session", "screenshot", "left_click", "right_click", "middle_click", "double_click", "left_click_drag", "mouse_move", "scroll", "type", "key", "wait"]);

  ipcMain.handle("shanaya:computer:confirm", async (_event, request) => {
    const action = String(request?.action || "");
    const approvalRequest = request?.input && typeof request.input === "object" ? request.input : {};
    const input = approvalRequest.input && typeof approvalRequest.input === "object" ? approvalRequest.input : {};
    if (!allowedActions.has(action)) throw new Error("Unsupported desktop action.");
    const summary = String(approvalRequest.summary || action.replaceAll("_", " ")).slice(0, 2600);
    const result = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "Confirm desktop action",
      message: action === "screenshot"
        ? "Share this desktop screenshot with Shanaya's configured AI provider?"
        : action === "session"
          ? "Start a desktop agent session? The task and any approved screenshots will be sent to the configured AI provider."
          : `Allow Shanaya to ${action.replaceAll("_", " ")}? This may activate controls, submit content, change settings, or send data.`,
      detail: summary,
      buttons: ["Continue", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (result.response !== 0) return null;
    const token = randomUUID();
    approvals.set(token, { action, inputJson: JSON.stringify(input), expiresAt: Date.now() + 15_000 });
    return token;
  });

  const consumeApproval = (token, action, input) => {
    const approval = approvals.get(String(token || ""));
    approvals.delete(String(token || ""));
    if (!approval || approval.expiresAt < Date.now() || approval.action !== action || approval.inputJson !== JSON.stringify(input)) {
      throw new Error("The desktop action has no matching, unexpired user approval.");
    }
  };

  ipcMain.handle("shanaya:computer:screenshot", async (_event, token) => {
    consumeApproval(token, "screenshot", {});
    const image = await screenshotDesktop({ format: "png" });
    const original = sharp(image);
    const source = await original.metadata();
    if (!source.width || !source.height) throw new Error("Could not read the desktop screenshot dimensions.");
    const jpeg = await original.resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 76 }).toBuffer({ resolveWithObject: true });
    lastImageSize = { width: jpeg.info.width, height: jpeg.info.height, displayWidth: source.width, displayHeight: source.height };
    return { base64: jpeg.data.toString("base64"), mediaType: "image/jpeg" };
  });

  ipcMain.handle("shanaya:computer:perform", async (_event, request) => {
    const action = String(request?.action || "");
    const input = request?.input && typeof request.input === "object" ? request.input : {};
    consumeApproval(request?.approvalToken, action, input);
    const point = (value) => {
      if (!lastImageSize || !Array.isArray(value) || value.length !== 2) throw new Error("Take a screenshot before using coordinates.");
      const x = Number(value[0]);
      const y = Number(value[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Invalid desktop coordinates.");
      if (x < 0 || y < 0 || x >= lastImageSize.width || y >= lastImageSize.height) throw new Error("The requested position is outside the current screenshot.");
      const scaleX = lastImageSize.displayWidth / lastImageSize.width;
      const scaleY = lastImageSize.displayHeight / lastImageSize.height;
      return new Point(Math.round(x * scaleX), Math.round(y * scaleY));
    };

    if (action === "left_click" || action === "right_click" || action === "middle_click" || action === "double_click") {
      if (input.coordinate) await mouse.setPosition(point(input.coordinate));
      const button = action === "right_click" ? Button.RIGHT : action === "middle_click" ? Button.MIDDLE : Button.LEFT;
      const modifiers = resolveModifiers(input.text);
      if (modifiers.length) await keyboard.pressKey(...modifiers);
      try {
        await mouse.click(button);
        if (action === "double_click") {
          await new Promise((resolve) => setTimeout(resolve, 100));
          await mouse.click(Button.LEFT);
        }
      } finally {
        if (modifiers.length) await keyboard.releaseKey(...modifiers);
      }
      return;
    }
    if (action === "mouse_move") {
      await mouse.setPosition(point(input.coordinate));
      return;
    }
    if (action === "left_click_drag") {
      await mouse.setPosition(point(input.start_coordinate));
      const modifiers = resolveModifiers(input.text);
      if (modifiers.length) await keyboard.pressKey(...modifiers);
      await mouse.pressButton(Button.LEFT);
      try {
        await mouse.setPosition(point(input.coordinate));
      } finally {
        await mouse.releaseButton(Button.LEFT);
        if (modifiers.length) await keyboard.releaseKey(...modifiers);
      }
      return;
    }
    if (action === "scroll") {
      if (input.coordinate) await mouse.setPosition(point(input.coordinate));
      const amount = Math.max(1, Math.min(20, Number(input.scroll_amount) || 3));
      const direction = String(input.scroll_direction || "down");
      const modifiers = resolveModifiers(input.text);
      if (modifiers.length) await keyboard.pressKey(...modifiers);
      try {
        if (direction === "up") await mouse.scrollUp(amount);
        else if (direction === "down") await mouse.scrollDown(amount);
        else if (direction === "left") await mouse.scrollLeft(amount);
        else if (direction === "right") await mouse.scrollRight(amount);
        else throw new Error("Unsupported scroll direction.");
      } finally {
        if (modifiers.length) await keyboard.releaseKey(...modifiers);
      }
      return;
    }
    if (action === "type") {
      const text = String(input.text || "");
      if (text.length > 2000) throw new Error("Desktop text entry is limited to 2,000 characters per action.");
      await keyboard.type(text);
      return;
    }
    if (action === "key") {
      const keys = resolveKeys(input.text);
      const repeat = Math.max(1, Math.min(100, Math.floor(Number(input.repeat) || 1)));
      for (let index = 0; index < repeat; index += 1) {
        await keyboard.pressKey(...keys);
        await keyboard.releaseKey(...keys);
      }
      return;
    }
    if (action === "wait") {
      const durationMs = Math.max(0, Math.min(2000, (Number(input.duration) || 0.5) * 1000));
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      return;
    }
    throw new Error(`Unsupported computer action: ${action}`);
  });

  mainWindow.on("closed", () => {
    ipcMain.removeHandler("shanaya:computer:confirm");
    ipcMain.removeHandler("shanaya:computer:screenshot");
    ipcMain.removeHandler("shanaya:computer:perform");
  });
}

module.exports = { installShanayaComputerBridge };
