package com.example.trade.service;

import com.example.trade.exception.BusinessException;
import com.example.trade.mapper.OrderMapper;
import org.springframework.stereotype.Service;

@Service
public class OrderDetailService {
    private final OrderMapper orderMapper;
    private final ReportService reportService;

    public OrderDetailService(OrderMapper orderMapper, ReportService reportService) {
        this.orderMapper = orderMapper;
        this.reportService = reportService;
    }

    public String detail(String orderId) {
        int itemCount = orderMapper.countSnapshotItems(orderId);
        if (itemCount < 0) {
            throw new BusinessException("ORDER_STATUS_INVALID", "订单状态非法");
        }
        return reportService.buildReportData(orderId);
    }
}
