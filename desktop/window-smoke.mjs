import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const near = (a, b) => ["x", "y", "width", "height"].every((key) => Math.abs(a[key] - b[key]) <= 1);
const contained = (bounds, areas) => areas.some((area) => bounds.x >= area.x - 1 && bounds.y >= area.y - 1 &&
  bounds.x + bounds.width <= area.x + area.width + 1 && bounds.y + bounds.height <= area.y + area.height + 1);
const settle = () => new Promise((resolve) => setTimeout(resolve, 180));
export async function verifyLayout({ phase, layout, mainWindow, widget, showWidget, store, app }) {
  const expectedFile = join(app.getPath("userData"), "expected-layout.json");
  const result = { phase };
  if (phase === "layout-write") {
    result.initialHidden = !widget && !layout.state().visible;
    const area = layout.areas()[0];
    mainWindow.setBounds({ x: area.x + 30, y: area.y + 35, width: Math.min(1000, area.width - 40), height: Math.min(760, area.height - 45) });
    await showWidget();
    layout.widget.setBounds({ x: area.x + 45, y: area.y + 50, width: 280, height: 430 });
    await layout.widget.webContents.executeJavaScript("document.querySelector('#widget-collapse').click()");
    await layout.widget.webContents.executeJavaScript("window.niriaDesktop.toggleTopmost()");
    await settle();
    result.collapsed = layout.state().collapsed && await layout.widget.webContents.executeJavaScript("document.body.classList.contains('collapsed')");
    result.unpinned = !layout.widget.isAlwaysOnTop() && await layout.widget.webContents.executeJavaScript("document.querySelector('#widget-topmost').getAttribute('aria-pressed') === 'false'");
    layout.captureMain();
    const expected = { main: mainWindow.getNormalBounds(), widget: layout.widget.getBounds() };
    result.saved = layout.preferences.flush();
    result.expected = expected;
    result.savedState = structuredClone(layout.preferences.state);
    await writeFile(expectedFile, JSON.stringify(expected));
    result.ok = result.initialHidden && result.collapsed && result.unpinned && result.saved;
  } else if (phase === "layout-read") {
    const expected = JSON.parse(await readFile(expectedFile, "utf8"));
    result.visibleRestored = !!widget && layout.state().visible;
    result.expected = expected;
    result.actual = { main: mainWindow.getNormalBounds(), widget: widget?.getBounds() };
    result.mainRestored = near(mainWindow.getNormalBounds(), expected.main);
    result.widgetRestored = !!widget && near(widget.getBounds(), expected.widget);
    result.flagsRestored = !!widget && !widget.isAlwaysOnTop() && layout.state().collapsed &&
      await widget.webContents.executeJavaScript("document.body.classList.contains('collapsed') && document.querySelector('#widget-topmost').getAttribute('aria-pressed') === 'false'");
    mainWindow.minimize();
    await settle();
    const beforeCapture = structuredClone(layout.preferences.state.main);
    layout.captureMain();
    result.minimizedIgnored = mainWindow.isMinimized() && JSON.stringify(beforeCapture) === JSON.stringify(layout.preferences.state.main);
    layout.showMain();
    await settle();
    result.mainRestores = !mainWindow.isMinimized() && mainWindow.isVisible();
    const mainFocused = mainWindow.isFocused();
    await showWidget({ reveal: true });
    await settle();
    result.widgetPreservesFocus = mainFocused && mainWindow.isFocused() && !widget.isFocused() && widget.isVisible();
    if (widget) {
      widget.setPosition(30000, 30000);
      layout.recover();
      await settle();
      result.offscreenRecovered = contained(widget.getBounds(), layout.areas());
      layout.findWidget();
      result.foundOnCursorDisplay = contained(widget.getBounds(), [layout.areas(true)[0]]);
      await widget.webContents.executeJavaScript("window.niriaDesktop.collapseWidget()");
      await widget.webContents.executeJavaScript("window.niriaDesktop.toggleTopmost()");
      widget.close(); // Alt+F4 follows the same native close handler.
      result.closeHides = !widget.isDestroyed() && !widget.isVisible() && !layout.state().visible;
    }
    mainWindow.maximize();
    await settle();
    layout.captureMain();
    result.maximizedSaved = mainWindow.isMaximized() && layout.preferences.state.main.maximized;
    result.saved = layout.preferences.flush();
    result.ok = result.visibleRestored && result.mainRestored && result.widgetRestored && result.flagsRestored &&
      result.minimizedIgnored && result.mainRestores && result.widgetPreservesFocus &&
      result.offscreenRecovered && result.foundOnCursorDisplay && result.closeHides && result.maximizedSaved && result.saved;
  } else if (phase === "layout-hidden") {
    result.hiddenRestored = !widget && !layout.state().visible;
    result.flagsRestored = !layout.state().collapsed && layout.state().alwaysOnTop;
    result.maximizedRestored = mainWindow.isMaximized();
    mainWindow.unmaximize();
    await settle();
    layout.captureMain();
    result.saved = layout.preferences.flush();
    result.ok = result.hiddenRestored && result.flagsRestored && result.maximizedRestored && result.saved;
  } else throw new Error("Unknown layout test phase");
  result.noModelCalls = store.state.calls.length === 0;
  result.ok &&= result.noModelCalls;
  return result;
}
