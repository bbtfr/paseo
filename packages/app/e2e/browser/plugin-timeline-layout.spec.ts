import type { Locator } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { withDirectoryPlugin } from "../support/helpers/plugin-timeline";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const SOURCE = `import React, { useState } from "react";
import { Text, View, Pressable } from "react-native";
import { z } from "zod";
function Notice({ item, timelineLayout }) {
  const [open, setOpen] = useState(false);
  return <View testID={"notice-" + item.data.position}>
    <Pressable accessibilityRole="button" onPress={() => setOpen(!open)} style={{ height: 32 }}>
      <Text>{item.data.position + " " + timelineLayout}</Text>
    </Pressable>
    {open && <View style={{ height: 80 }}><Text>Expanded notification body</Text></View>}
  </View>;
}
export default function contribute(client) {
  for (const itemType of ["tool_call", "assistant_message"]) {
    client.addTimelineTransformer({ id: itemType.replaceAll("_", "-"), query: { itemType }, transform({ item }) {
      const middle = item.type === "tool_call" && item.name === "read";
      const tail = item.type === "assistant_message" && item.text.includes("(end of synthetic stream)");
      if (!middle && !tail) return undefined;
      return { items: [{ type: "plugin", kind: "notice", version: 1, layout: "tool",
        data: { position: middle ? "middle" : "tail" } }] };
    } });
  }
  client.addTimelineRenderer({ kind: "notice", version: 1,
    schema: z.object({ position: z.string() }), Component: Notice });
  return () => {};
}`;

async function bottomMargin(row: Locator): Promise<number> {
  return row
    .locator('xpath=ancestor::*[@data-testid="plugin-timeline-tool-row"][1]')
    .evaluate((element) => parseFloat(getComputedStyle(element).marginBottom));
}

for (const width of [1100, 390]) {
  test(`plugin tool rows retain native middle and footer spacing at width ${width}`, async ({
    page,
  }, info) => {
    info.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "plugin-layout-",
      title: "Plugin tool layout",
      model: "ten-second-stream",
    });
    try {
      await withDirectoryPlugin({
        pluginId: "tool-layout-e2e",
        source: SOURCE,
        run: async () => {
          await openAgentRoute(page, agent);
          await expect(
            page.getByRole("textbox", { name: "Message agent..." }).first(),
          ).toBeVisible();
          await agent.client.sendAgentMessage(agent.agentId, "Exercise notification layout.");
          await agent.client.waitForFinish(agent.agentId, 30_000);
          const middle = page.getByTestId("notice-middle").first();
          const tail = page.getByTestId("notice-tail");
          await expect(middle.getByText("middle tool", { exact: true })).toBeAttached();
          await expect(tail.getByText("tail tool", { exact: true })).toBeVisible();
          await expect.poll(() => bottomMargin(middle)).toBe(4);
          await expect.poll(() => bottomMargin(tail)).toBe(16);
          const footer = page.getByText(/^Worked for /).last();
          await expect(footer).toBeVisible();
          const gap = async () => {
            const rowBox = await tail.boundingBox(),
              footerBox = await footer.boundingBox();
            if (!rowBox || !footerBox) throw new Error("Missing row or footer bounds");
            return footerBox.y - rowBox.y - rowBox.height;
          };
          const collapsedGap = await gap();
          expect(collapsedGap).toBeGreaterThanOrEqual(16);
          await tail.getByRole("button").click();
          await expect(tail.getByText("Expanded notification body")).toBeVisible();
          expect(await gap()).toBeCloseTo(collapsedGap, 0);
          await middle.scrollIntoViewIfNeeded();
          await middle.getByRole("button").click();
          await expect(middle.getByText("Expanded notification body")).toBeVisible();
          expect(await bottomMargin(middle)).toBe(4);
          await info.attach("plugin-tool-layout", {
            body: await page.screenshot(),
            contentType: "image/png",
          });
          await page.reload({ waitUntil: "domcontentloaded" });
          await expect(tail.getByText("tail tool", { exact: true })).toBeVisible();
          expect(await bottomMargin(tail)).toBe(16);
          expect(await bottomMargin(middle)).toBe(4);
        },
      });
    } finally {
      await agent.cleanup();
    }
  });
}
