package com.example.trade.mapper;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface OrderMapper {
    int countSnapshotItems(@Param("orderId") String orderId);
}
