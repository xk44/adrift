/**
 * SREF Parser Tests
 * ==================
 * Unit tests for the style reference parser.
 * 
 * Run with: npm test or npx vitest
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  parseExtendedPrompt,
  formatSREF,
  formatLoRA,
  generateRandomStyleCode,
  resolveRandomSREFs,
  getSREFValue,
} from "@/lib/sref/srefParser";
import type { SREFParams, SREFItem, LoRAParams } from "@/lib/sref/srefParser";

describe("parseExtendedPrompt", () => {
  describe("Basic prompt parsing", () => {
    it("should parse a simple prompt without parameters", () => {
      const result = parseExtendedPrompt("a beautiful landscape");
      
      expect(result.prompt).toBe("a beautiful landscape");
      expect(result.sref).toBeNull();
      expect(result.lora).toBeNull();
      expect(result.errors).toHaveLength(0);
    });

    it("should handle empty prompt", () => {
      const result = parseExtendedPrompt("");
      
      expect(result.prompt).toBe("");
      expect(result.errors).toHaveLength(0);
    });

    it("should preserve quoted strings", () => {
      const result = parseExtendedPrompt('a "beautiful landscape" with mountains');
      
      expect(result.prompt).toBe("a beautiful landscape with mountains");
    });
  });

  describe("SREF parsing", () => {
    it("should parse single style code", () => {
      const result = parseExtendedPrompt("portrait --sref 2952812633");
      
      expect(result.prompt).toBe("portrait");
      expect(result.sref).not.toBeNull();
      expect(result.sref?.items).toHaveLength(1);
      expect(result.sref?.items[0].value).toBe("2952812633");
      expect(result.sref?.items[0].type).toBe("code");
      expect(result.sref?.items[0].weight).toBe(1.0);
    });

    it("should parse style code with weight", () => {
      const result = parseExtendedPrompt("portrait --sref 2952812633::2.5");
      
      expect(result.sref?.items[0].value).toBe("2952812633");
      expect(result.sref?.items[0].weight).toBe(2.5);
    });

    it("should parse multiple style codes", () => {
      const result = parseExtendedPrompt("portrait --sref 1234567890 9876543210");
      
      expect(result.sref?.items).toHaveLength(2);
      expect(result.sref?.items[0].value).toBe("1234567890");
      expect(result.sref?.items[1].value).toBe("9876543210");
    });

    it("should parse multiple style codes with individual weights", () => {
      const result = parseExtendedPrompt("portrait --sref 1234567890::2 9876543210::0.5");
      
      expect(result.sref?.items[0].weight).toBe(2);
      expect(result.sref?.items[1].weight).toBe(0.5);
    });

    it("should parse URL as style reference", () => {
      const result = parseExtendedPrompt("portrait --sref https://example.com/style.jpg");
      
      expect(result.sref?.items[0].value).toBe("https://example.com/style.jpg");
      expect(result.sref?.items[0].type).toBe("url");
    });

    it("should parse 'random' as special SREF type", () => {
      const result = parseExtendedPrompt("portrait --sref random");
      
      expect(result.sref?.items[0].value).toBe("random");
      expect(result.sref?.items[0].type).toBe("random");
    });

    it("should parse mixed style references", () => {
      const result = parseExtendedPrompt(
        "portrait --sref https://example.com/a.jpg 1234567890::1.5 random"
      );
      
      expect(result.sref?.items).toHaveLength(3);
      expect(result.sref?.items[0].type).toBe("url");
      expect(result.sref?.items[1].type).toBe("code");
      expect(result.sref?.items[1].weight).toBe(1.5);
      expect(result.sref?.items[2].type).toBe("random");
    });

    it("should report error for empty --sref", () => {
      const result = parseExtendedPrompt("portrait --sref --ar 16:9");
      
      expect(result.errors).toContain("--sref requires at least one image URL");
    });
  });

  describe("Style weight (SW) parsing", () => {
    it("should parse style weight", () => {
      const result = parseExtendedPrompt("portrait --sw 200");
      
      expect(result.sref?.styleWeight).toBe(200);
    });

    it("should parse style weight with SREF", () => {
      const result = parseExtendedPrompt("portrait --sref 1234567890 --sw 500");
      
      expect(result.sref?.items).toHaveLength(1);
      expect(result.sref?.styleWeight).toBe(500);
    });

    it("should default style weight to 100", () => {
      const result = parseExtendedPrompt("portrait --sref 1234567890");
      
      expect(result.sref?.styleWeight).toBe(100);
    });

    it("should report error for out-of-range style weight", () => {
      const result = parseExtendedPrompt("portrait --sw 1500");
      
      expect(result.errors).toContain("--sw must be a number between 0 and 1000");
    });

    it("should report error for missing style weight value", () => {
      const result = parseExtendedPrompt("portrait --sw --ar 16:9");
      
      expect(result.errors).toContain("--sw requires a value");
    });
  });

  describe("Style version (SV) parsing", () => {
    it("should parse style version", () => {
      const result = parseExtendedPrompt("portrait --sv 2");
      
      expect(result.sref?.styleVersion).toBe(2);
    });

  });

  describe("LoRA parsing", () => {
    it("should parse single LoRA", () => {
      const result = parseExtendedPrompt("portrait --lora anime_style");
      
      expect(result.lora).not.toBeNull();
      expect(result.lora?.items).toHaveLength(1);
      expect(result.lora?.items[0].name).toBe("anime_style");
      expect(result.lora?.items[0].strength).toBe(1.0);
    });

    it("should parse LoRA with strength", () => {
      const result = parseExtendedPrompt("portrait --lora anime_style::0.8");
      
      expect(result.lora?.items[0].strength).toBe(0.8);
    });

    it("should parse LoRA with model and CLIP strength", () => {
      const result = parseExtendedPrompt("portrait --lora anime_style::0.8::0.5");
      
      expect(result.lora?.items[0].strength).toBe(0.8);
      expect(result.lora?.items[0].clipStrength).toBe(0.5);
    });

    it("should parse multiple LoRAs", () => {
      const result = parseExtendedPrompt("portrait --lora anime_style::0.8 detail_enhancer::0.5");
      
      expect(result.lora?.items).toHaveLength(2);
      expect(result.lora?.items[0].name).toBe("anime_style");
      expect(result.lora?.items[1].name).toBe("detail_enhancer");
    });

    it("should clamp LoRA strength to valid range", () => {
      const result = parseExtendedPrompt("portrait --lora test::5.0");
      
      expect(result.lora?.items[0].strength).toBe(2.0); // Clamped to max
    });

    it("should identify random LoRA", () => {
      const result = parseExtendedPrompt("portrait --lora random");
      
      expect(result.lora?.items[0].isRandom).toBe(true);
    });
  });

  describe("Auto-trigger parsing", () => {
    it("should parse --autotrigger flag", () => {
      const result = parseExtendedPrompt("portrait --lora anime_style --autotrigger");
      
      expect(result.lora?.autoTrigger).toBe(true);
      expect(result.lora?.triggerPosition).toBe("beginning");
    });

    it("should parse --autotrigger with position", () => {
      const result = parseExtendedPrompt("portrait --lora anime_style --autotrigger middle");
      
      expect(result.lora?.autoTrigger).toBe(true);
      expect(result.lora?.triggerPosition).toBe("middle");
    });

    it("should parse --autotrigger end position", () => {
      const result = parseExtendedPrompt("portrait --lora anime_style --autotrigger end");
      
      expect(result.lora?.triggerPosition).toBe("end");
    });
  });

  describe("Other parameters passthrough", () => {
    it("should pass through unknown parameters", () => {
      const result = parseExtendedPrompt("portrait --ar 16:9 --stylize 200");
      
      expect(result.otherParams.ar).toBe("16:9");
      expect(result.otherParams.stylize).toBe("200");
    });

    it("should handle boolean flags", () => {
      const result = parseExtendedPrompt("portrait --raw --draft");
      
      expect(result.otherParams.raw).toBe(true);
      expect(result.otherParams.draft).toBe(true);
    });
  });

  describe("Complex prompts", () => {
    it("should parse full complex prompt", () => {
      const result = parseExtendedPrompt(
        "a beautiful anime portrait --sref 1234567890::2 random::0.5 --sw 300 --lora anime_style::0.8 --autotrigger --ar 16:9"
      );
      
      expect(result.prompt).toBe("a beautiful anime portrait");
      expect(result.sref?.items).toHaveLength(2);
      expect(result.sref?.styleWeight).toBe(300);
      expect(result.lora?.items).toHaveLength(1);
      expect(result.lora?.autoTrigger).toBe(true);
      expect(result.otherParams.ar).toBe("16:9");
    });
  });
});

describe("formatSREF", () => {
  it("should format basic SREF params", () => {
    const sref: SREFParams = {
      items: [{ value: "1234567890", type: "code", weight: 1.0 }],
      styleWeight: 100,
    };
    
    expect(formatSREF(sref)).toBe("--sref 1234567890");
  });

  it("should format SREF with weight", () => {
    const sref: SREFParams = {
      items: [{ value: "1234567890", type: "code", weight: 2.0 }],
      styleWeight: 100,
    };
    
    expect(formatSREF(sref)).toBe("--sref 1234567890::2");
  });

  it("should format multiple items", () => {
    const sref: SREFParams = {
      items: [
        { value: "1234567890", type: "code", weight: 1.0 },
        { value: "9876543210", type: "code", weight: 0.5 },
      ],
      styleWeight: 100,
    };
    
    expect(formatSREF(sref)).toBe("--sref 1234567890 9876543210::0.5");
  });

  it("should include style weight when not default", () => {
    const sref: SREFParams = {
      items: [{ value: "1234567890", type: "code", weight: 1.0 }],
      styleWeight: 200,
    };
    
    expect(formatSREF(sref)).toBe("--sref 1234567890 --sw 200");
  });

  it("should include style version when specified", () => {
    const sref: SREFParams = {
      items: [{ value: "1234567890", type: "code", weight: 1.0 }],
      styleWeight: 100,
      styleVersion: 2,
    };
    
    expect(formatSREF(sref)).toBe("--sref 1234567890 --sv 2");
  });
});

describe("formatLoRA", () => {
  it("should format basic LoRA params", () => {
    const lora: LoRAParams = {
      items: [{ name: "anime_style", strength: 1.0 }],
      autoTrigger: false,
      triggerPosition: "beginning",
    };
    
    expect(formatLoRA(lora)).toBe("--lora anime_style");
  });

  it("should format LoRA with strength", () => {
    const lora: LoRAParams = {
      items: [{ name: "anime_style", strength: 0.8 }],
      autoTrigger: false,
      triggerPosition: "beginning",
    };
    
    expect(formatLoRA(lora)).toBe("--lora anime_style::0.8");
  });

  it("should format LoRA with CLIP strength", () => {
    const lora: LoRAParams = {
      items: [{ name: "anime_style", strength: 0.8, clipStrength: 0.5 }],
      autoTrigger: false,
      triggerPosition: "beginning",
    };
    
    expect(formatLoRA(lora)).toBe("--lora anime_style::0.8::0.5");
  });

  it("should include autotrigger when enabled", () => {
    const lora: LoRAParams = {
      items: [{ name: "anime_style", strength: 1.0 }],
      autoTrigger: true,
      triggerPosition: "beginning",
    };
    
    expect(formatLoRA(lora)).toBe("--lora anime_style --autotrigger");
  });

  it("should include trigger position when not default", () => {
    const lora: LoRAParams = {
      items: [{ name: "anime_style", strength: 1.0 }],
      autoTrigger: true,
      triggerPosition: "middle",
    };
    
    expect(formatLoRA(lora)).toBe("--lora anime_style --autotrigger middle");
  });
});

describe("generateRandomStyleCode", () => {
  it("should generate a 10-digit numeric string", () => {
    const code = generateRandomStyleCode();
    
    expect(code).toMatch(/^\d{10}$/);
  });

  it("should generate different codes on each call", () => {
    const codes = new Set<string>();
    
    for (let i = 0; i < 100; i++) {
      codes.add(generateRandomStyleCode());
    }
    
    // Should have at least 95 unique codes out of 100
    expect(codes.size).toBeGreaterThan(95);
  });
});

describe("resolveRandomSREFs", () => {
  it("should resolve random items to codes", () => {
    const sref: SREFParams = {
      items: [
        { value: "random", type: "random", weight: 1.0 },
      ],
      styleWeight: 100,
    };
    
    const resolved = resolveRandomSREFs(sref);
    
    expect(resolved.items[0].resolved).toMatch(/^\d{10}$/);
  });

  it("should not modify non-random items", () => {
    const sref: SREFParams = {
      items: [
        { value: "1234567890", type: "code", weight: 1.0 },
      ],
      styleWeight: 100,
    };
    
    const resolved = resolveRandomSREFs(sref);
    
    expect(resolved.items[0].resolved).toBeUndefined();
  });

  it("should not re-resolve already resolved items", () => {
    const sref: SREFParams = {
      items: [
        { value: "random", type: "random", weight: 1.0, resolved: "5555555555" },
      ],
      styleWeight: 100,
    };
    
    const resolved = resolveRandomSREFs(sref);
    
    expect(resolved.items[0].resolved).toBe("5555555555");
  });
});

describe("getSREFValue", () => {
  it("should return value for code type", () => {
    const item: SREFItem = { value: "1234567890", type: "code", weight: 1.0 };
    
    expect(getSREFValue(item)).toBe("1234567890");
  });

  it("should return value for URL type", () => {
    const item: SREFItem = { value: "https://example.com/img.jpg", type: "url", weight: 1.0 };
    
    expect(getSREFValue(item)).toBe("https://example.com/img.jpg");
  });

  it("should return resolved value for random type", () => {
    const item: SREFItem = { value: "random", type: "random", weight: 1.0, resolved: "9999999999" };
    
    expect(getSREFValue(item)).toBe("9999999999");
  });

  it("should return 'random' if not resolved", () => {
    const item: SREFItem = { value: "random", type: "random", weight: 1.0 };
    
    expect(getSREFValue(item)).toBe("random");
  });
});

describe("Roundtrip parsing", () => {
  it("should roundtrip SREF params through format and parse", () => {
    const original: SREFParams = {
      items: [
        { value: "1234567890", type: "code", weight: 2.0 },
        { value: "9876543210", type: "code", weight: 0.5 },
      ],
      styleWeight: 300,
      styleVersion: 2,
    };
    
    const formatted = formatSREF(original);
    const parsed = parseExtendedPrompt(`test prompt ${formatted}`);
    
    expect(parsed.sref?.items).toHaveLength(2);
    expect(parsed.sref?.items[0].value).toBe("1234567890");
    expect(parsed.sref?.items[0].weight).toBe(2);
    expect(parsed.sref?.items[1].value).toBe("9876543210");
    expect(parsed.sref?.items[1].weight).toBe(0.5);
    expect(parsed.sref?.styleWeight).toBe(300);
    expect(parsed.sref?.styleVersion).toBe(2);
  });

  it("should roundtrip LoRA params through format and parse", () => {
    const original: LoRAParams = {
      items: [
        { name: "anime_style", strength: 0.8, clipStrength: 0.5 },
        { name: "detail_enhancer", strength: 0.6 },
      ],
      autoTrigger: true,
      triggerPosition: "middle",
    };
    
    const formatted = formatLoRA(original);
    const parsed = parseExtendedPrompt(`test prompt ${formatted}`);
    
    expect(parsed.lora?.items).toHaveLength(2);
    expect(parsed.lora?.items[0].name).toBe("anime_style");
    expect(parsed.lora?.items[0].strength).toBe(0.8);
    expect(parsed.lora?.items[0].clipStrength).toBe(0.5);
    expect(parsed.lora?.items[1].name).toBe("detail_enhancer");
    expect(parsed.lora?.items[1].strength).toBe(0.6);
    expect(parsed.lora?.autoTrigger).toBe(true);
    expect(parsed.lora?.triggerPosition).toBe("middle");
  });
});
