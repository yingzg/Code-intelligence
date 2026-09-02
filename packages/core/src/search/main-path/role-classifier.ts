import type { CodeLocation } from "../../schemas.js";

export type NodeRole =
  | "entry"
  | "controller"
  | "provider"
  | "application_service"
  | "domain_service"
  | "repository"
  | "mapper"
  | "sql"
  | "external_dependency"
  | "validation"
  | "parameter_assembly"
  | "exception"
  | "lock"
  | "utility"
  | "dto"
  | "test"
  | "unknown";

export type ClassifiedNode = {
  id: string;
  role: NodeRole;
  score: number;
  reasons: string[];
};

type Rule = {
  role: NodeRole;
  score: number;
  reason: string;
  matches: (input: RoleInput) => boolean;
};

type RoleInput = {
  id: string;
  file: string;
  symbol: string;
  snippet: string;
  haystack: string;
};

export function classifyNode(anchor: CodeLocation): ClassifiedNode {
  const input = roleInput(anchor);
  const matched: Array<{ role: NodeRole; score: number; reason: string }> = [];

  for (const rule of RULES) {
    if (rule.matches(input)) {
      matched.push({
        role: rule.role,
        score: rule.score,
        reason: rule.reason
      });
    }
  }

  const best = matched.sort((left, right) => right.score - left.score)[0];
  if (!best) {
    return {
      id: anchor.id,
      role: "unknown",
      score: 0,
      reasons: ["未命中通用 Java 角色规则。"]
    };
  }

  return {
    id: anchor.id,
    role: best.role,
    score: best.score,
    reasons: matched
      .filter((item) => item.role === best.role)
      .map((item) => item.reason)
  };
}

function roleInput(anchor: CodeLocation): RoleInput {
  const file = normalize(anchor.file);
  const symbol = anchor.symbol ?? symbolFromId(anchor.id);
  const snippet = anchor.snippet ?? "";
  return {
    id: anchor.id,
    file,
    symbol,
    snippet,
    haystack: `${anchor.id}\n${file}\n${symbol}\n${snippet}`
  };
}

const RULES: Rule[] = [
  {
    role: "test",
    score: 100,
    reason: "src/test 路径或 Test 类通常是测试代码。",
    matches: (input) => isTestFile(input.file) || /\b\w+Test\b/.test(input.symbol)
  },
  {
    role: "controller",
    score: 95,
    reason: "Controller 类名或 Web 注解表示请求入口。",
    matches: (input) => /(?:Controller|Endpoint|Resource)\b/.test(input.symbol)
      || /@(RestController|Controller|RequestMapping|GetMapping|PostMapping)\b/.test(input.snippet)
  },
  {
    role: "provider",
    score: 90,
    reason: "Provider、Facade 或 ApiImpl 后缀通常是应用对外适配层。",
    matches: (input) => /(?:Provider(?:Impl)?|Facade(?:Impl)?|ApiImpl|RpcImpl)\b/.test(input.symbol)
  },
  {
    role: "repository",
    score: 88,
    reason: "Repository、Dao 或 Gateway 表示数据访问边界。",
    matches: (input) => /(?:Repository|RepositoryImpl|Dao|Gateway)\b/.test(input.symbol)
      || /\/(?:repository|dao|gateway)\//i.test(input.file)
  },
  {
    role: "mapper",
    score: 86,
    reason: "Mapper 类名或 mapper 路径表示 MyBatis 映射层。",
    matches: (input) => /(?:Mapper)\b/.test(input.symbol) || /\/mapper\//i.test(input.file)
  },
  {
    role: "lock",
    score: 84,
    reason: "Lock、Redisson 或 synchronized 表示锁相关细节。",
    matches: (input) => /(?:Lock|Redisson|synchronized)/i.test(input.haystack)
  },
  {
    role: "exception",
    score: 83,
    reason: "Exception、ErrorCode 或 throw 表示异常构造或异常处理。",
    matches: (input) => /(?:Exception|ErrorCode|\bthrow\b)/.test(input.haystack)
  },
  {
    role: "validation",
    score: 82,
    reason: "check、validate、assert、ensure 通常是参数校验。",
    matches: (input) => /(?:^|\.)(?:check|validate|assert|ensure)[A-Z_\w$]*/.test(input.symbol)
  },
  {
    role: "parameter_assembly",
    score: 78,
    reason: "build、assemble、convert、mapTo 通常是参数组装或转换。",
    matches: (input) => /(?:^|\.)(?:build|assemble|convert|mapTo)[A-Z_\w$]*/.test(input.symbol)
  },
  {
    role: "dto",
    score: 72,
    reason: "DTO、VO、ValObj、Request、Response、Param 通常是数据载体。",
    matches: (input) => /(?:DTO|Dto|VO|ValObj|Request|Response|Param)\b/.test(input.symbol)
  },
  {
    role: "utility",
    score: 70,
    reason: "Util、Utils 或 Helper 通常是工具细节。",
    matches: (input) => /(?:Util|Utils|Helper)\b/.test(input.symbol)
  },
  {
    role: "application_service",
    score: 68,
    reason: "CommandService、QueryService 或 ApplicationService 通常是应用服务。",
    matches: (input) => /(?:(?:Command|Query|Application)Service(?:Impl)?)\b/.test(input.symbol)
  },
  {
    role: "domain_service",
    score: 64,
    reason: "ServiceImpl、DomainService 或 Manager 通常是领域服务。",
    matches: (input) => /(?:ServiceImpl|DomainService|Manager)\b/.test(input.symbol)
  },
  {
    role: "sql",
    score: 60,
    reason: "SQL 文件或 select/insert/update/delete 片段表示 SQL 证据。",
    matches: (input) => input.file.endsWith(".sql")
      || input.file.endsWith(".xml") && /\b(select|insert|update|delete)\b/i.test(input.snippet)
  }
];

function symbolFromId(id: string): string {
  return id.split(":").at(-1)?.replace(/#\d+$/, "") ?? id;
}

function normalize(file: string): string {
  return file.replaceAll("\\", "/");
}

function isTestFile(file: string): boolean {
  return file.startsWith("src/test/") || file.includes("/src/test/");
}
