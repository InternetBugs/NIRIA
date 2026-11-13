// Structural fixture only: the 16-byte MOC3 header is not a playable model.
// This asset is generated here and contains no third-party character artwork.
export function live2DFixture(label = "结构测试") {
  const root = `合成模型/${label}`;
  const moc = Buffer.alloc(16);
  moc.write("MOC3");
  const model = { Version: 3, FileReferences: {
    Moc: "model.moc3", Textures: ["texture.png"],
    Expressions: [{ Name: "微笑", File: "smile.exp3.json" }, { Name: "害羞", File: "shy.exp3.json" }],
    Motions: { Idle: [{ File: "idle.motion3.json", Sound: "ignored.wav" }] }
  } };
  const values = [
    ["model.model3.json", JSON.stringify(model)],
    ["model.moc3", moc],
    ["texture.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")],
    ["smile.exp3.json", '{"Type":"Live2D Expression","Parameters":[]}'],
    ["shy.exp3.json", '{"Type":"Live2D Expression","Parameters":[]}'],
    ["idle.motion3.json", '{"Version":3,"Curves":[]}']
  ];
  return { format: "niria-live2d", version: 1, model: `${root}/model.model3.json`,
    files: values.map(([path, data]) => ({ path: `${root}/${path}`, data: Buffer.from(data).toString("base64") })) };
}
export function live2DAvatarFixture(label) {
  return { format: "niria-live2d-avatar", version: 1, package: live2DFixture(label),
    bindings: { idleGroup: "Idle", expressions: { smile: "微笑", shy: "害羞" } } };
}
