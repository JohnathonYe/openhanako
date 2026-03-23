import { describe, expect, it } from "vitest";
import {
  filterImagesForModelInput,
  isMimeAllowedForModelInput,
  mediaCapsFromModelInput,
  mimeMediaKind,
} from "../lib/model-media-capabilities.js";

describe("model-media-capabilities", () => {
  it("mediaCapsFromModelInput defaults to text-only", () => {
    expect(mediaCapsFromModelInput(undefined)).toEqual({
      allowImage: false,
      allowVideo: false,
      allowAudio: false,
    });
    expect(mediaCapsFromModelInput(null)).toEqual({
      allowImage: false,
      allowVideo: false,
      allowAudio: false,
    });
    expect(mediaCapsFromModelInput(["text"])).toEqual({
      allowImage: false,
      allowVideo: false,
      allowAudio: false,
    });
  });

  it("mediaCapsFromModelInput reads image video audio flags", () => {
    expect(mediaCapsFromModelInput(["text", "image", "video", "audio"])).toEqual({
      allowImage: true,
      allowVideo: true,
      allowAudio: true,
    });
    expect(mediaCapsFromModelInput(["text", "image"])).toEqual({
      allowImage: true,
      allowVideo: false,
      allowAudio: false,
    });
  });

  it("mimeMediaKind", () => {
    expect(mimeMediaKind("image/png")).toBe("image");
    expect(mimeMediaKind("video/mp4")).toBe("video");
    expect(mimeMediaKind("audio/mpeg")).toBe("audio");
    expect(mimeMediaKind("application/json")).toBe(null);
  });

  it("isMimeAllowedForModelInput", () => {
    const imgOnly = ["text", "image"];
    expect(isMimeAllowedForModelInput("image/png", imgOnly)).toBe(true);
    expect(isMimeAllowedForModelInput("video/mp4", imgOnly)).toBe(false);
    expect(isMimeAllowedForModelInput("audio/wav", imgOnly)).toBe(false);
    const all = ["text", "image", "video", "audio"];
    expect(isMimeAllowedForModelInput("video/mp4; codecs=foo", all)).toBe(true);
  });

  it("filterImagesForModelInput", () => {
    const imgs = [
      { mimeType: "image/png", data: "x" },
      { mimeType: "video/mp4", data: "y" },
    ];
    const imgOnly = ["text", "image"];
    expect(filterImagesForModelInput(imgs, imgOnly)).toEqual([{ mimeType: "image/png", data: "x" }]);
    expect(filterImagesForModelInput(imgs, ["text", "image", "video", "audio"])).toEqual(imgs);
    expect(filterImagesForModelInput([{ mimeType: "video/mp4" }], imgOnly)).toBeUndefined();
    expect(filterImagesForModelInput(undefined, imgOnly)).toBeUndefined();
  });
});
