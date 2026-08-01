import http from "k6/http";
import { check, sleep } from "k6";

const config = {
  runId: __ENV.RUN_ID || "local-run",
  testId: __ENV.TEST_ID || "k6-demo",
  serviceId: __ENV.SERVICE_ID || "json-placeholder",
  environment: __ENV.TEST_ENVIRONMENT || "demo",
  profile: __ENV.TEST_PROFILE || "baseline",
  baseUrl: __ENV.BASE_URL || "https://jsonplaceholder.typicode.com",
  endpoint: __ENV.ENDPOINT || "/posts",
  gitCommit: __ENV.GIT_COMMIT || "unknown",
  jenkinsBuildNumber: __ENV.JENKINS_BUILD_NUMBER || "local",
  jenkinsBuildUrl: __ENV.JENKINS_BUILD_URL || null,
  jenkinsJobName: __ENV.JOB_NAME || __ENV.JENKINS_JOB_NAME || null, // add this
};

export const options = {
  stages: [
    { duration: __ENV.RAMP_UP_DURATION || "10s", target: Number(__ENV.VIRTUAL_USERS || 10) },
    { duration: __ENV.STEADY_DURATION || "15s", target: Number(__ENV.VIRTUAL_USERS || 10) },
    { duration: __ENV.RAMP_DOWN_DURATION || "5s", target: 0 },
  ],

  thresholds: {
    http_req_duration: [
      `p(95)<${Number(__ENV.P95_THRESHOLD_MS || 500)}`,
    ],
    http_req_failed: [
      `rate<${Number(__ENV.ERROR_RATE_THRESHOLD || 0.01)}`,
    ],
    checks: ["rate>0.99"],
  },

  tags: {
    run_id: config.runId,
    test_id: config.testId,
    service_id: config.serviceId,
    environment: config.environment,
    profile: config.profile,
  },
};

export default function () {
  const response = http.get(
    `${config.baseUrl}${config.endpoint}`,
    {
      tags: {
        operation: "get-posts",
      },
    },
  );

  check(response, {
    "status is 200": (result) => result.status === 200,
    "response time is acceptable": (result) =>
      result.timings.duration <
      Number(__ENV.P95_THRESHOLD_MS || 500),
  });

  sleep(Number(__ENV.THINK_TIME_SECONDS || 1));
}

function metricValue(data, metricName, valueName) {
  return data.metrics?.[metricName]?.values?.[valueName] ?? null;
}

function thresholdResults(data) {
  return Object.entries(data.metrics ?? {}).flatMap(
    ([metricName, metric]) =>
      Object.entries(metric.thresholds ?? {}).map(
        ([requirement, result]) => ({
          metric: metricName,
          requirement,
          passed: result.ok === true,
        }),
      ),
  );
}

export function handleSummary(data) {
  const thresholds = thresholdResults(data);
  const passed = thresholds.every((threshold) => threshold.passed);

  const result = {
    schemaVersion: 1,

    run: {
      id: config.runId,
      testId: config.testId,
      serviceId: config.serviceId,
      environment: config.environment,
      profile: config.profile,
      status: passed ? "PASSED" : "FAILED",
    },

    source: {
      gitCommit: config.gitCommit,
      jenkinsBuildNumber: config.jenkinsBuildNumber,
      jenkinsBuildUrl: config.jenkinsBuildUrl,
      jenkinsJobName: config.jenkinsJobName,
    },

    configuration: {
      baseUrl: config.baseUrl,
      endpoint: config.endpoint,

      // Store only explicitly approved, non-secret variables.
      variables: {
        rampUpDuration: __ENV.RAMP_UP_DURATION || "30s",
        steadyDuration: __ENV.STEADY_DURATION || "1m",
        rampDownDuration: __ENV.RAMP_DOWN_DURATION || "10s",
        virtualUsers: Number(__ENV.VIRTUAL_USERS || 10),
        p95ThresholdMs: Number(__ENV.P95_THRESHOLD_MS || 500),
        errorRateThreshold: Number(__ENV.ERROR_RATE_THRESHOLD || 0.01),
        thinkTimeSeconds: Number(__ENV.THINK_TIME_SECONDS || 1),
      },
    },

    metrics: {
      requests: metricValue(
        data,
        "http_reqs",
        "count",
      ),
      requestsPerSecond: metricValue(
        data,
        "http_reqs",
        "rate",
      ),
      errorRate: metricValue(
        data,
        "http_req_failed",
        "rate",
      ),
      checkPassRate: metricValue(
        data,
        "checks",
        "rate",
      ),
      latencyMilliseconds: {
        average: metricValue(
          data,
          "http_req_duration",
          "avg",
        ),
        minimum: metricValue(
          data,
          "http_req_duration",
          "min",
        ),
        median: metricValue(
          data,
          "http_req_duration",
          "med",
        ),
        p90: metricValue(
          data,
          "http_req_duration",
          "p(90)",
        ),
        p95: metricValue(
          data,
          "http_req_duration",
          "p(95)",
        ),
        p99: metricValue(
          data,
          "http_req_duration",
          "p(99)",
        ),
        maximum: metricValue(
          data,
          "http_req_duration",
          "max",
        ),
      },
      iterations: metricValue(
        data,
        "iterations",
        "count",
      ),
      virtualUsersMaximum: metricValue(
        data,
        "vus_max",
        "max",
      ),
      dataReceivedBytes: metricValue(
        data,
        "data_received",
        "count",
      ),
      dataSentBytes: metricValue(
        data,
        "data_sent",
        "count",
      ),
    },

    thresholds,

    generatedAt: new Date().toISOString(),
  };

  return {
    stdout: JSON.stringify(result, null, 2),
    "results/portal-result.json": JSON.stringify(
      result,
      null,
      2,
    ),
    "results/raw-k6-summary.json": JSON.stringify(
      data,
      null,
      2,
    ),
  };
}