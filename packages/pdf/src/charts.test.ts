import { describe, expect, it } from "vitest";
import { barChart, pieChart } from "./charts.js";

describe("inline SVG charts", () => {
  it("renders escaped labels and themed bars without external assets", () => {
    const svg = barChart(
      [
        { label: '<script>alert("x")</script>', value: 12 },
        { label: "FAILED", value: 3 },
      ],
      "#1565c0",
      "Runs by status",
    );

    expect(svg).toContain("<svg");
    expect(svg).toContain('fill="#1565c0"');
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain("<img");
    expect(svg).not.toMatch(/(?:href|src)=["']https?:\/\//u);
  });

  it("renders a single 100 percent pie slice as a circle", () => {
    const svg = pieChart([{ label: "SUCCESS", value: 42 }], "#1565c0", "Run share");

    expect(svg).toContain("<circle");
    expect(svg).toContain("SUCCESS: 42 (100%)");
    expect(svg).not.toContain("<path");
    expect(svg).not.toContain("NaN");
  });

  it("renders multiple slices as vector paths", () => {
    const svg = pieChart(
      [
        { label: "SUCCESS", value: 9 },
        { label: "FAILED", value: 1 },
      ],
      "#1565c0",
    );

    expect(svg.match(/<path/g)).toHaveLength(2);
    expect(svg).toContain("SUCCESS: 9 (90%)");
    expect(svg).toContain("FAILED: 1 (10%)");
  });

  it("renders a safe empty state without invalid geometry", () => {
    for (const svg of [barChart([], "#1565c0"), pieChart([], "#1565c0")]) {
      expect(svg).toContain("No data in this period.");
      expect(svg).not.toContain("NaN");
      expect(svg).not.toContain("Infinity");
    }
  });
});
