import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSqlIndex } from "../src/indexer/sql-indexer.js";

describe("buildSqlIndex", () => {
  it("indexes MyBatis XML table names and mapper ids", async () => {
    const root = join(process.cwd(), "fixtures/java-order-service");
    const entries = await buildSqlIndex({ project: "trade-service", root });

    expect(entries).toContainEqual(
      expect.objectContaining({
        table: "order_item_snapshot",
        mapper_id: "countSnapshotItems",
        namespace: "com.example.trade.mapper.OrderMapper",
        file: "src/main/resources/mapper/OrderMapper.xml"
      })
    );

    const entry = entries.find((candidate) => candidate.table === "order_item_snapshot");
    expect(entry?.sql_excerpt).toBe("select count(*) from order_item_snapshot where order_id = #{orderId}");
  });

  it("indexes XML join, update, and insert tables without duplicates", async () => {
    const root = await createProject({
      "src/main/resources/mapper/ReportMapper.xml": `
        <mapper namespace="example.ReportMapper">
          <select id="list">
            select *
            from order_header h
            join order_item_snapshot s on s.order_id = h.id
            join order_item_snapshot s2 on s2.order_id = h.id
          </select>
          <update id="mark">
            update order_header set status = 'DONE'
          </update>
          <insert id="add">
            insert into order_audit(id) values(1)
          </insert>
        </mapper>
      `
    });

    const entries = await buildSqlIndex({ project: "demo", root });

    expect(entries).toContainEqual(expect.objectContaining({ mapper_id: "list", table: "order_header" }));
    expect(entries).toContainEqual(expect.objectContaining({ mapper_id: "list", table: "order_item_snapshot" }));
    expect(entries).toContainEqual(expect.objectContaining({ mapper_id: "mark", table: "order_header" }));
    expect(entries).toContainEqual(expect.objectContaining({ mapper_id: "add", table: "order_audit" }));
    expect(entries.filter((entry) => entry.mapper_id === "list" && entry.table === "order_item_snapshot")).toHaveLength(1);
  });

  it("indexes backtick table names and schema-qualified table names", async () => {
    const root = await createProject({
      "src/main/resources/mapper/QuotedMapper.xml": `
        <mapper namespace="example.QuotedMapper">
          <select id="find">
            select *
            from \`order\`
            join trade.order_item on order_item.order_id = \`order\`.id
          </select>
        </mapper>
      `
    });

    const entries = await buildSqlIndex({ project: "demo", root });

    expect(entries).toContainEqual(expect.objectContaining({ table: "order" }));
    expect(entries).toContainEqual(expect.objectContaining({ table: "trade.order_item" }));
  });

  it("indexes Java annotation SQL with mapper method names", async () => {
    const root = await createProject({
      "src/main/java/example/AnnotationMapper.java": `
        package example;

        import org.apache.ibatis.annotations.Mapper;
        import org.apache.ibatis.annotations.Select;

        @Mapper
        public interface AnnotationMapper {
            @Select("select * from trade_order where id = #{id}")
            TradeOrder findById(String id);

            @Select("select * from value_order where value = #{value}")
            TradeOrder findByValue(String value);
        }
      `
    });

    const entries = await buildSqlIndex({ project: "demo", root });

    expect(entries).toContainEqual(
      expect.objectContaining({
        table: "trade_order",
        mapper_id: "findById",
        namespace: "example.AnnotationMapper",
        file: "src/main/java/example/AnnotationMapper.java"
      })
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        table: "value_order",
        mapper_id: "findByValue",
        namespace: "example.AnnotationMapper"
      })
    );
  });

  it("uses table occurrence lines within the current SQL block", async () => {
    const root = await createProject({
      "src/main/resources/mapper/LineMapper.xml": `
        <mapper namespace="example.LineMapper">
          <select id="a">
            select *
            from order_header
          </select>

          <select id="b">
            select *
            from trade.order_header
          </select>
        </mapper>
      `
    });

    const entries = await buildSqlIndex({ project: "demo", root });
    const first = entries.find((entry) => entry.mapper_id === "a" && entry.table === "order_header");
    const second = entries.find((entry) => entry.mapper_id === "b" && entry.table === "trade.order_header");

    expect(first?.line).not.toBe(second?.line);
    expect(second?.line).toBeGreaterThan(first?.line ?? 0);
    expect(second?.id).toContain(`:${second?.line}:b:trade.order_header`);
  });

  it("keeps CDATA SQL content and masks SQL string literals", async () => {
    const root = await createProject({
      "src/main/resources/mapper/CdataMapper.xml": `
        <mapper namespace='example.CdataMapper'>
          <select id='find'>
            <![CDATA[
              select 'from fake_table' as message
              from cdata_table
              where score < 10
            ]]>
          </select>
        </mapper>
      `
    });

    const entries = await buildSqlIndex({ project: "demo", root });

    expect(entries).toContainEqual(
      expect.objectContaining({
        namespace: "example.CdataMapper",
        mapper_id: "find",
        table: "cdata_table"
      })
    );
    expect(entries.find((entry) => entry.table === "cdata_table")?.line).toBeGreaterThan(4);
    expect(entries.map((entry) => entry.table)).not.toContain("fake_table");
  });

  it("ignores pseudo Java SQL annotations in comments and strings", async () => {
    const root = await createProject({
      "src/main/java/example/CommentedMapper.java": `
        package example;

        import org.apache.ibatis.annotations.Select;

        public interface CommentedMapper {
            /**
             * Example: @Select("select * from doc_table")
             */
            Object helper();

            default String text() {
                return "@Select(\\"select * from string_table\\")";
            }

            default String textBlock() {
                return """
                  @Select("select * from text_block_fake_table")
                  """;
            }

            // @Select("select * from old_table")
            @Select("select * from real_table")
            Object real();
        }
      `
    });

    const entries = await buildSqlIndex({ project: "demo", root });
    const tables = entries.map((entry) => entry.table);

    expect(tables).toEqual(["real_table"]);
  });

  it("uses only Java annotation value SQL and supports text blocks", async () => {
    const root = await createProject({
      "src/main/java/example/ValueMapper.java": `
        package example;

        import org.apache.ibatis.annotations.Select;

        public interface ValueMapper {
            @Select({
              "select *",
              "from array_value_table",
              "where status = #{status}"
            })
            Object arraySql();

            @Select(value = "select * from value_table", databaseId = "mysql")
            Object valueSql();

            @Select(
              value = """
              select *
              from text_block_table
              where id = #{id}
              """
            )
            Object textBlockSql();
        }
      `
    });

    const entries = await buildSqlIndex({ project: "demo", root });

    expect(entries).toContainEqual(expect.objectContaining({ mapper_id: "valueSql", table: "value_table" }));
    expect(entries).toContainEqual(expect.objectContaining({ mapper_id: "textBlockSql", table: "text_block_table" }));
    expect(entries).toContainEqual(expect.objectContaining({ mapper_id: "arraySql", table: "array_value_table" }));
    const arrayEntry = entries.find((entry) => entry.table === "array_value_table");
    expect(entries.find((entry) => entry.table === "text_block_table")?.line).toBeGreaterThan(
      entries.find((entry) => entry.table === "value_table")?.line ?? 0
    );
    expect(arrayEntry?.line).toBeGreaterThan(0);
    expect(entries.map((entry) => entry.table)).not.toContain("mysql");
  });

  it("does not dedupe same table across different statements", async () => {
    const root = await createProject({
      "src/main/resources/mapper/DuplicateMapper.xml": `
        <mapper namespace="example.DuplicateMapper">
          <select id="one">select * from duplicate_table where status = 1</select>
          <select id="two">select * from duplicate_table where status = 2</select>
        </mapper>
      `
    });

    const entries = await buildSqlIndex({ project: "demo", root });

    const duplicateEntries = entries.filter((entry) => entry.table === "duplicate_table");
    expect(duplicateEntries).toHaveLength(2);
    expect(new Set(duplicateEntries.map((entry) => entry.line)).size).toBe(2);
    for (const entry of duplicateEntries) {
      expect(entry.id).toContain(`:${entry.line}:${entry.mapper_id}:duplicate_table`);
    }
  });

  it("indexes quoted SQL identifiers without masking them", async () => {
    const root = await createProject({
      "src/main/resources/mapper/IdentifierMapper.xml": `
        <mapper namespace="example.IdentifierMapper">
          <select id="quoted">
            select *
            from "quoted_table"
            join [audit_table] on audit_table.id = quoted_table.id
          </select>
        </mapper>
      `
    });

    const entries = await buildSqlIndex({ project: "demo", root });

    expect(entries).toContainEqual(expect.objectContaining({ table: "quoted_table" }));
    expect(entries).toContainEqual(expect.objectContaining({ table: "audit_table" }));
  });

  it("limits long SQL excerpts", async () => {
    const longColumns = Array.from({ length: 120 }, (_, index) => `column_${index}`).join(", ");
    const root = await createProject({
      "src/main/resources/mapper/LongMapper.xml": `
        <mapper namespace="example.LongMapper">
          <select id="long">select ${longColumns} from long_table</select>
        </mapper>
      `
    });

    const entries = await buildSqlIndex({ project: "demo", root });
    const entry = entries.find((candidate) => candidate.table === "long_table");

    expect(entry?.sql_excerpt.length).toBeLessThanOrEqual(500);
    expect(entry?.sql_excerpt.endsWith("...")).toBe(true);
  });

  it("ignores SQL files under build output directories", async () => {
    const root = await createProject({
      "src/main/resources/mapper/VisibleMapper.xml": `
        <mapper namespace="example.VisibleMapper">
          <select id="visible">select * from visible_table</select>
        </mapper>
      `,
      "src/main/resources/target/HiddenMapper.xml": `
        <mapper namespace="example.HiddenMapper">
          <select id="hidden">select * from hidden_table</select>
        </mapper>
      `,
      "src/main/java/build/example/HiddenMapper.java": `
        package example;
        import org.apache.ibatis.annotations.Select;
        public interface HiddenMapper {
            @Select("select * from hidden_java_table")
            Object hidden();
        }
      `
    });

    const entries = await buildSqlIndex({ project: "demo", root });
    const tables = entries.map((entry) => entry.table);

    expect(tables).toEqual(["visible_table"]);
  });
});

async function createProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "code-intel-sql-"));

  for (const [relativeFile, content] of Object.entries(files)) {
    const file = join(root, relativeFile);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, trimFixture(content), "utf8");
  }

  return root;
}

function trimFixture(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => line.replace(/^ {8}/, ""))
    .join("\n")
    .trimStart();
}
