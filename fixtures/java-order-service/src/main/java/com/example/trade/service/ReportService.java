package com.example.trade.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

@Service
public class ReportService {
    private static final Logger log = LoggerFactory.getLogger(ReportService.class);

    public String buildReportData(String orderId) {
        log.error("detail failed while building report data, orderId={}", orderId, new RuntimeException("ClientAbortException: Broken pipe"));
        return "report:" + orderId;
    }
}
