import { describe, expect, it } from "vitest";
import { createGitNexusAdapter } from "../src/gitnexus/adapter.js";
import {
  mapGitNexusContextToRelations,
  mapGitNexusDefinitionsToLocations,
  mapGitNexusTraceToRelations
} from "../src/gitnexus/mapper.js";

describe("GitNexus adapter", () => {
  it("passes explicit repo labels to context calls", async () => {
    const calls: string[][] = [];
    const adapter = createGitNexusAdapter({
      run: async (args) => {
        calls.push(args);
        return {
          status: "found",
          symbol: {
            uid: "Class:src/A.java:A",
            name: "A",
            kind: "Class",
            filePath: "src/A.java",
            startLine: 1,
            endLine: 10
          },
          incoming: {},
          outgoing: {},
          typed_properties: [],
          processes: []
        };
      }
    });

    await adapter.context({ repoPath: "/repo", repo: "mi-intl-scheme", symbol: "A", limit: 5 });

    expect(calls[0]).toEqual(["context", "A", "--repo", "mi-intl-scheme", "--limit", "5"]);
  });

  it("passes zero-ambiguity uid hints to trace calls", async () => {
    const calls: string[][] = [];
    const adapter = createGitNexusAdapter({
      run: async (args) => {
        calls.push(args);
        return { path: [] };
      }
    });

    await adapter.trace({
      repoPath: "/repo",
      repo: "mi-intl-scheme",
      from: "A.run",
      to: "B.call",
      fromUid: "Method:src/A.java:A.run#0",
      toUid: "Method:src/B.java:B.call#0",
      depth: 6
    });

    expect(calls[0]).toEqual([
      "trace",
      "A.run",
      "B.call",
      "--repo",
      "mi-intl-scheme",
      "--depth",
      "6",
      "--from-uid",
      "Method:src/A.java:A.run#0",
      "--to-uid",
      "Method:src/B.java:B.call#0"
    ]);
  });

  it("maps GitNexus definitions to gitnexus CodeLocation records", async () => {
    const locations = await mapGitNexusDefinitionsToLocations({
      project: "p",
      root: process.cwd(),
      definitions: [
        {
          id: "Method:src/A.java:A.run#0",
          name: "run",
          filePath: "src/A.java",
          startLine: 12,
          endLine: 20
        }
      ]
    });

    expect(locations[0]).toMatchObject({
      id: "Method:src/A.java:A.run#0",
      project: "p",
      file: "src/A.java",
      start_line: 12,
      end_line: 20,
      symbol: "run",
      language: "java",
      source: "gitnexus"
    });
  });

  it("maps GitNexus context edges to CodeRelation records", () => {
    const relations = mapGitNexusContextToRelations({
      fromLocationId: "Class:src/A.java:A",
      context: {
        incoming: {
          implements: [
            { uid: "Class:src/AImpl.java:AImpl", name: "AImpl", filePath: "src/AImpl.java" }
          ]
        },
        outgoing: {
          calls: [
            { uid: "Method:src/B.java:B.call#0", name: "call", filePath: "src/B.java" }
          ],
          annotated_by: [
            { uid: "Class:src/Anno.java:Anno", name: "Anno", filePath: "src/Anno.java" }
          ],
          extends: [
            { uid: "Class:src/Base.java:Base", name: "Base", filePath: "src/Base.java" }
          ],
          method_overrides: [
            { uid: "Method:src/Base.java:Base.run#0", name: "run", filePath: "src/Base.java" }
          ],
          has_property: [
            { uid: "Property:src/A.java:A.value", name: "value", filePath: "src/A.java" }
          ]
        },
        typed_properties: [
          { uid: "Property:src/C.java:C.a", name: "a", filePath: "src/C.java", declaredType: "A" }
        ]
      }
    });

    expect(relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "Class:src/AImpl.java:AImpl",
          to: "Class:src/A.java:A",
          relation_type: "implements"
        }),
        expect.objectContaining({
          from: "Class:src/A.java:A",
          to: "Method:src/B.java:B.call#0",
          relation_type: "calls",
          raw_relation_type: "calls"
        }),
        expect.objectContaining({
          from: "Class:src/A.java:A",
          to: "Class:src/Anno.java:Anno",
          relation_type: "references",
          raw_relation_type: "annotated_by"
        }),
        expect.objectContaining({
          from: "Class:src/A.java:A",
          to: "Class:src/Base.java:Base",
          relation_type: "extends"
        }),
        expect.objectContaining({
          from: "Class:src/A.java:A",
          to: "Method:src/Base.java:Base.run#0",
          relation_type: "method_overrides"
        }),
        expect.objectContaining({
          from: "Class:src/A.java:A",
          to: "Property:src/A.java:A.value",
          relation_type: "has_property"
        }),
        expect.objectContaining({
          from: "Property:src/C.java:C.a",
          to: "Class:src/A.java:A",
          relation_type: "typed_as",
          raw_relation_type: "typed_as"
        })
      ])
    );
  });

  it("maps common trace path shapes to calls relations", () => {
    const relations = mapGitNexusTraceToRelations({
      path: [
        { uid: "Method:src/A.java:A.a#0", name: "a", filePath: "src/A.java" },
        { uid: "Method:src/B.java:B.b#0", name: "b", filePath: "src/B.java" }
      ]
    });

    expect(relations).toEqual([
      expect.objectContaining({
        from: "Method:src/A.java:A.a#0",
        to: "Method:src/B.java:B.b#0",
        relation_type: "calls"
      })
    ]);
  });

  it("maps GitNexus hops and edge relTypes to typed relations", () => {
    const relations = mapGitNexusTraceToRelations({
      hops: [
        { name: "A", filePath: "src/A.java", startLine: 10 },
        { name: "run", filePath: "src/A.java", startLine: 20 },
        { name: "call", filePath: "src/B.java", startLine: 30 }
      ],
      edges: [
        { relType: "HAS_METHOD", confidence: 1 },
        { relType: "CALLS", confidence: 0.85 }
      ]
    });

    expect(relations).toEqual([
      expect.objectContaining({
        from: "Trace:src/A.java:10:A",
        to: "Trace:src/A.java:20:run",
        relation_type: "has_method",
        raw_relation_type: "HAS_METHOD"
      }),
      expect.objectContaining({
        from: "Trace:src/A.java:20:run",
        to: "Trace:src/B.java:30:call",
        relation_type: "calls",
        raw_relation_type: "CALLS"
      })
    ]);
  });
});
