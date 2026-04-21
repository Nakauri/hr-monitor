package com.nakauri.hrmonitor.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.nakauri.hrmonitor.ui.theme.BrandColors

/**
 * 5 pip rectangles, same as the widget's `.pips`. The pip matching the
 * current stage lights up in that stage's colour; the rest stay grey.
 *
 * Desktop CSS: 6 px tall, 6 px gap between pips, each pip flex:1.
 * `.pip.active` swaps the background to the stage colour.
 */
@Composable
fun HrPips(
    activeStageKey: String?,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(6.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        BrandColors.StageOrder.forEach { stageKey ->
            val active = stageKey == activeStageKey
            val color = if (active) BrandColors.stageColor(stageKey) else Color(0xFF1A1A1A)
            androidx.compose.foundation.layout.Box(
                modifier = Modifier
                    .weight(1f)
                    .height(6.dp)
                    .background(color, RoundedCornerShape(2.dp))
                    .padding(0.dp)
            )
        }
    }
}
