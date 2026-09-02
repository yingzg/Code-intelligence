package com.example.trade.web;

import com.example.trade.service.OrderDetailService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/trade/order")
public class OrderController {
    private final OrderDetailService orderDetailService;

    public OrderController(OrderDetailService orderDetailService) {
        this.orderDetailService = orderDetailService;
    }

    @GetMapping("/detail")
    // 查询订单详情
    public String detail(@RequestParam String orderId) {
        return orderDetailService.detail(orderId);
    }
}
