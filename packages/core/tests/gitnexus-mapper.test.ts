import { describe, expect, it } from "vitest";
import {
  findUnknownGitNexusRelationTypes,
  mapGitNexusContextToRelations
} from "../src/gitnexus/mapper.js";

describe("GitNexus mapper", () => {
  it("maps incoming method_implements relations without marking them unknown", () => {
    const relations = mapGitNexusContextToRelations({
      fromLocationId: "Method:src/I.java:I.run#0",
      context: {
        incoming: {
          method_implements: [
            { uid: "Method:src/A.java:A.run#0", name: "run", filePath: "src/A.java" }
          ]
        }
      }
    });

    expect(relations).toEqual([
      expect.objectContaining({
        from: "Method:src/A.java:A.run#0",
        to: "Method:src/I.java:I.run#0",
        relation_type: "method_implements",
        raw_relation_type: "method_implements"
      })
    ]);
    expect(findUnknownGitNexusRelationTypes(relations)).not.toContain("method_implements");
  });
});
