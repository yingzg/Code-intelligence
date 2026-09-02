package com.example.trade.enums;

public enum OrderStatusEnum {
    ORDER_STATUS_INVALID("ORDER_STATUS_INVALID", "订单状态非法");

    private final String code;
    private final String message;

    OrderStatusEnum(String code, String message) {
        this.code = code;
        this.message = message;
    }
}
