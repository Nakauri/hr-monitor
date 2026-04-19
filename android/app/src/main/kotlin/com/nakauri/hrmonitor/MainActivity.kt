package com.nakauri.hrmonitor

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.nakauri.hrmonitor.ui.theme.HRMonitorTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            HRMonitorTheme {
                Scaffold(modifier = Modifier.fillMaxSize()) { inner ->
                    PhaseZeroPlaceholder(modifier = Modifier.padding(inner))
                }
            }
        }
    }
}

@Composable
private fun PhaseZeroPlaceholder(modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("HR Monitor", style = MaterialTheme.typography.headlineMedium)
        Text(
            "Native Android build, Phase 0 scaffold.",
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}
